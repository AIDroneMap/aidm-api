const { test, expect, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'libs', 'Task.js'), 'utf8');
const statusCodes = require('../../libs/statusCodes');
const cleanups = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createTask(overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-fallback-'));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'archive', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'archive', 'result.txt'), 'complete result');
    fs.writeFileSync(path.join(directory, 'archive', 'nested', 'data.json'), '{"ok":true}');
    const dependencies = {
        '../config': { test: false, has7z: false },
        './logger': { info() {}, debug() {}, warn() {}, error() {} },
        './odmRunner': { run: (options, uuid, callback) => {
            queueMicrotask(() => callback(null, 0));
            return {};
        } },
        './odmInfo': {},
        './processRunner': {},
        './Directories': { data: directory },
        './S3': { enabled: () => false },
        './utils': { parseUnsafePathsList: paths => paths },
        './appRoot': {},
        './statusCodes': statusCodes,
        ...overrides
    };
    const sandbox = {
        module: { exports: {} },
        require: dependency => Object.hasOwn(dependencies, dependency) ? dependencies[dependency] : require(dependency),
        setInterval,
        clearInterval,
        setTimeout
    };
    vm.runInNewContext(source, sandbox, { filename: 'Task.js' });
    const task = new sandbox.module.exports('archive', 'Archive', [], null, true, ['result.txt', 'nested', 'missing']);
    cleanups.push(() => task.stopTrackingProcessingTime());
    task.setStatus(statusCodes.QUEUED);
    const outcome = { calls: 0 };
    outcome.completed = new Promise(resolve => task.start(error => {
        outcome.calls++;
        outcome.error = error;
        resolve();
    }));
    return { task, outcome, zipPath: path.join(directory, 'archive', 'all.zip') };
}

function readZip(filename) {
    const archive = fs.readFileSync(filename);
    const end = archive.lastIndexOf(Buffer.from('504b0506', 'hex'));
    expect(end).toBe(archive.length - 22);
    let position = archive.readUInt32LE(end + 16);
    const entries = {};
    for (let entry = 0; entry < archive.readUInt16LE(end + 10); entry++) {
        expect(archive.readUInt32LE(position)).toBe(0x02014b50);
        const nameLength = archive.readUInt16LE(position + 28);
        const name = archive.toString('utf8', position + 46, position + 46 + nameLength);
        const local = archive.readUInt32LE(position + 42);
        const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
        const data = archive.subarray(start, start + archive.readUInt32LE(position + 20));
        entries[name] = (archive.readUInt16LE(position + 10) === 8 ? zlib.inflateRawSync(data) : data).toString();
        position += 46 + nameLength + archive.readUInt16LE(position + 30) + archive.readUInt16LE(position + 32);
    }
    return entries;
}

test('pins Archiver 8 with its ZIP constructor', () => {
    expect(require('../../package.json').dependencies.archiver).toBe('8.0.0');
    expect(typeof require('archiver').ZipArchive).toBe('function');
});

test('completed fallback archives can be read immediately with their file contents intact', async () => {
    const { task, outcome, zipPath } = createTask();
    await outcome.completed;
    expect(outcome.error).toBeUndefined();
    expect(outcome.calls).toBe(1);
    expect(task.status.code).toBe(statusCodes.COMPLETED);
    const entries = readZip(zipPath);
    expect(entries['result.txt']).toBe('complete result');
    expect(entries['nested/data.json']).toBe('{"ok":true}');
    expect(Object.keys(entries).filter(name => !name.endsWith('/')).sort()).toEqual(['nested/data.json', 'result.txt']);
});

test('waits for the output close event before completing the task', async () => {
    let releaseClose;
    let closeReached;
    const reached = new Promise(resolve => closeReached = resolve);
    const { task, outcome } = createTask({ fs: {
        ...fs,
        createWriteStream: filename => {
            const output = fs.createWriteStream(filename);
            const emit = output.emit;
            output.emit = function(event, ...args) {
                if (event === 'close') {
                    releaseClose = () => emit.call(this, event, ...args);
                    closeReached();
                    return true;
                }
                return emit.call(this, event, ...args);
            };
            return output;
        }
    } });
    await reached;
    expect(outcome.calls).toBe(0);
    expect(task.status.code).toBe(statusCodes.RUNNING);
    releaseClose();
    await outcome.completed;
    expect(outcome.calls).toBe(1);
    expect(task.status.code).toBe(statusCodes.COMPLETED);
});

test.each(['archive', 'output'])('reports a ZIP %s error once even if close follows', async target => {
    const output = new EventEmitter();
    const error = new Error('Archive write failed');
    class FailedArchive extends EventEmitter {
        pipe() {}
        file() {}
        directory() {}
        finalize() {
            queueMicrotask(() => {
                (target === 'archive' ? this : output).emit('error', error);
                output.emit('close');
            });
        }
    }
    const { task, outcome } = createTask({
        fs: { ...fs, createWriteStream: () => output },
        archiver: { create: () => new FailedArchive(), ZipArchive: FailedArchive }
    });
    await outcome.completed;
    expect(outcome.error).toBe(error);
    expect(outcome.calls).toBe(1);
    expect(task.status.code).toBe(statusCodes.FAILED);
});
