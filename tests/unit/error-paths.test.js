const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const statusCodes = require('../../libs/statusCodes');

function loadModule(filename, replacements, globals = {}) {
    const modulePath = path.join(__dirname, '..', '..', 'libs', filename);
    const requireModule = createRequire(modulePath);
    const loaded = { exports: {} };
    vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), {
        module: loaded,
        require: name => Object.hasOwn(replacements, name) ? replacements[name] : requireModule(name),
        process,
        console,
        setInterval,
        clearInterval,
        ...globals
    }, { filename: modulePath });
    return loaded.exports;
}

function zipEntries(filename) {
    const archive = fs.readFileSync(filename);
    const end = archive.length - 22;
    expect(archive.readUInt32LE(end)).toBe(0x06054b50);
    let offset = archive.readUInt32LE(end + 16);
    const entries = [];
    for (let index = 0; index < archive.readUInt16LE(end + 10); index++) {
        expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
        const nameLength = archive.readUInt16LE(offset + 28);
        entries.push(archive.toString('utf8', offset + 46, offset + 46 + nameLength));
        offset += 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
    }
    return entries.sort();
}

test('the archive fallback includes wildcard matches, files and directories without 7z', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-archive-'));
    const project = path.join(temporary, 'task');
    fs.mkdirSync(path.join(project, 'tiles', 'directory.tif'), { recursive: true });
    fs.mkdirSync(path.join(project, 'reports'));
    fs.writeFileSync(path.join(project, 'tiles', 'first.tif'), 'first tile');
    fs.writeFileSync(path.join(project, 'tiles', 'second.tif'), 'second tile');
    fs.writeFileSync(path.join(project, 'tiles', 'skip.txt'), 'not selected');
    fs.writeFileSync(path.join(project, 'metadata.json'), '{}');
    fs.writeFileSync(path.join(project, 'reports', 'report.txt'), 'report');
    const Task = loadModule('Task.js', {
        '../config': { test: false, has7z: false },
        './logger': { info() {}, debug() {}, error() {} },
        './Directories': { data: temporary },
        './odmRunner': { run: (options, name, done) => { done(null, 0); } },
        './odmInfo': {},
        './processRunner': {},
        './S3': { enabled: () => false }
    });
    const task = new Task('task', 'archive', [], null, true,
        ['tiles/*.tif', 'metadata.json', 'reports', 'missing.txt', 'empty/*.tif']);
    task.setStatus(statusCodes.QUEUED);
    try {
        await new Promise((resolve, reject) => {
            expect(task.start(error => error ? reject(error) : resolve())).toBe(true);
        });
        expect(task.getStatus()).toBe(statusCodes.COMPLETED);
        expect(zipEntries(task.getAssetsArchivePath('all.zip'))).toEqual([
            'first.tif', 'metadata.json', 'reports/report.txt', 'second.tif'
        ]);
    } finally {
        task.stopTrackingProcessingTime();
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

for (const cleanup of ['success', 'missing', 'failure']) {
    test(`engine options survive temporary-file cleanup ${cleanup}`, () => {
        const child = new EventEmitter();
        const warnings = [];
        const results = [];
        const deleted = [];
        const spawned = [];
        const options = [{ name: 'dsm', type: 'bool' }];
        const runner = loadModule('odmRunner.js', {
            '../config.js': { test: false, odx_path: '/engine' },
            './logger': {},
            'fs': {
                readFile: (filename, settings, done) => done(null, JSON.stringify(options)),
                exists: (filename, done) => done(cleanup !== 'missing'),
                unlink: (filename, done) => {
                    deleted.push(filename);
                    done(cleanup === 'failure' ? new Error('permission denied') : null);
                }
            },
            'child_process': {
                spawn: (command, params, settings) => {
                    spawned.push(settings.env.ODX_OPTIONS_TMP_FILE);
                    return child;
                }
            }
        }, { console: { warn: message => warnings.push(message) } });
        runner.getJsonOptions((...result) => results.push(result));
        expect(() => child.emit('exit', 0, null)).not.toThrow();
        expect(results).toEqual([[null, options]]);
        expect(spawned).toHaveLength(1);
        expect(deleted).toEqual(cleanup === 'missing' ? [] : spawned);
        expect(warnings).toEqual(cleanup === 'failure' ? [`Cannot cleanup ${spawned[0]}`] : []);
    });
}
