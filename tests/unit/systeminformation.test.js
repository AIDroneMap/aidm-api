const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const si = require('systeminformation');

const root = path.join(__dirname, '..', '..');
const expectedVersion = '5.33.18';
const MiB = 1024 * 1024;
const logger = { info() {}, warn() {}, debug() {} };

function loadSource(file, overrides, globals = {}) {
    const filename = path.join(root, file);
    const originalRequire = createRequire(filename);
    const context = vm.createContext({
        module: { exports: {} },
        require: name => Object.hasOwn(overrides, name) ? overrides[name] : originalRequire(name),
        process,
        setTimeout,
        ...globals
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return context;
}

test('the direct systeminformation dependency has the upgraded exact pin', () => {
    expect(require('../../package.json').dependencies.systeminformation).toBe(expectedVersion);
});

test('the loaded systeminformation runtime is the upgraded version', () => {
    expect(si.version()).toBe(expectedVersion);
});

test('cpu supplies one data argument to the callback used by /info', async () => {
    const args = await new Promise(resolve => si.cpu((...values) => resolve(values)));
    expect(args).toHaveLength(1);
    expect(Number.isInteger(args[0].cores)).toBe(true);
    expect(args[0].cores).toBeGreaterThan(0);
});

test('mem supplies total and available bytes to the callback used by both callers', async () => {
    const args = await new Promise(resolve => si.mem((...values) => resolve(values)));
    expect(args).toHaveLength(1);
    expect(Number.isFinite(args[0].total)).toBe(true);
    expect(args[0].total).toBeGreaterThan(0);
    expect(Number.isFinite(args[0].available)).toBe(true);
    expect(args[0].available).toBeGreaterThanOrEqual(0);
    expect(args[0].available).toBeLessThanOrEqual(args[0].total);
});

test('/info maps callback data to totalMemory, availableMemory and logical cpuCores', async () => {
    let infoHandler;
    const calls = [];
    const app = {
        use() {}, options() {}, post() {},
        get(route, ...handlers) {
            if (route === '/info') infoHandler = handlers.at(-1);
        }
    };
    const express = Object.assign(() => app, { static() {} });
    const config = { maxImages: 37, parallelQueueProcessing: 2, hasUnzip: true, has7z: true };
    const context = loadSource('index.js', {
        './config.js': config,
        './libs/logger': logger,
        './libs/storage': { fields() {} },
        './libs/TaskManager': {},
        './libs/taskNew': {},
        './libs/S3': {},
        './libs/auth/factory': { fromConfig: () => ({ getMiddleware() {} }) },
        './libs/odmInfo': {
            getVersion: cb => cb(null, 'test-version'),
            getEngine: cb => cb(null, 'test-engine'),
            getEngineUpstreamVersion: cb => cb(null, 'test-upstream')
        },
        express,
        async: { ...require('async'), series() {} },
        systeminformation: {
            cpu(cb) {
                calls.push('cpu');
                queueMicrotask(() => cb({ cores: 12, physicalCores: 6, processors: 1 }));
            },
            mem(cb) {
                calls.push('mem');
                queueMicrotask(() => cb({ total: 16000 * MiB, available: 7000 * MiB, free: 1000 * MiB }));
            }
        }
    }, { process: { on() {} } });
    vm.runInContext('taskManager = { getQueueCount: () => 3 };', context);

    const result = await new Promise(resolve => infoHandler({ query: {} }, { json: resolve }));
    expect(calls.sort()).toEqual(['cpu', 'mem']);
    expect(result).toEqual({
        version: require('../../package.json').version,
        taskQueueCount: 3,
        totalMemory: 16000 * MiB,
        availableMemory: 7000 * MiB,
        cpuCores: 12,
        maxImages: 37,
        maxParallelTasks: 2,
        engineVersion: 'test-version',
        engine: 'test-engine',
        upstreamVersion: require('../../package.json').upstreamVersion,
        engineUpstreamVersion: 'test-upstream'
    });
});

for (const [availableMiB, queueSize, partMiB] of [
    [4000, 10, 100],
    [800, 2, 100],
    [256, 1, 64],
    [0, 1, 5]
]) {
    test(`S3 uploadPaths sets queueSize ${queueSize} and partSize ${partMiB} MiB with ${availableMiB} MiB available`, async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-s3-memory-'));
        const uploads = [];
        let memoryCalls = 0;
        class S3Client {
            send() { return Promise.resolve(); }
        }
        class Upload {
            constructor(options) {
                this.options = options;
                uploads.push(options);
            }
            on() {}
            async done() {
                for await (const chunk of this.options.params.Body) {
                    expect(chunk.toString()).toBe('result');
                }
            }
        }
        const context = loadSource('libs/S3.js', {
            '../config': { s3Endpoint: 'https://', s3Bucket: '<bucket>', s3ACL: 'none' },
            './logger': logger,
            '@aws-sdk/client-s3': { S3Client, PutObjectCommand: class {} },
            '@aws-sdk/lib-storage': { Upload },
            systeminformation: {
                mem(cb) {
                    memoryCalls++;
                    queueMicrotask(() => cb({ available: availableMiB * MiB, free: 8000 * MiB, total: 16000 * MiB }));
                }
            }
        });
        const s3 = context.module.exports;
        try {
            fs.writeFileSync(path.join(folder, 'result.txt'), 'result');
            await new Promise((resolve, reject) => s3.initialize(err => err ? reject(err) : resolve()));
            await new Promise((resolve, reject) => {
                s3.uploadPaths(folder, '<bucket>', 'results', ['result.txt'], err => err ? reject(err) : resolve());
            });
            expect(memoryCalls).toBe(1);
            expect(uploads).toHaveLength(1);
            expect(uploads[0].queueSize).toBe(queueSize);
            expect(uploads[0].partSize).toBe(partMiB * MiB);
            expect(uploads[0].params.Key).toBe(path.join('results', 'result.txt'));
        } finally {
            fs.rmSync(folder, { recursive: true, force: true });
        }
    });
}
