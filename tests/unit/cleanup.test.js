const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const root = path.join(__dirname, '..', '..');
const uuid = '11111111-2222-4333-8444-555555555555';
let directory;
let filesystem;
let removals;
let onRemoval;

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-cleanup-'));
    removals = [];
    onRemoval = () => {};
    filesystem = {
        ...fs,
        exists: (target, cb) => fs.exists(path.resolve(directory, target), cb),
        readdir: (target, cb) => fs.readdir(path.resolve(directory, target), cb),
        stat: (target, cb) => fs.stat(path.resolve(directory, target), cb),
        statSync: target => fs.statSync(path.resolve(directory, target)),
        rm: (target, options, cb) => {
            removals.push({ target, options });
            fs.rm(path.resolve(directory, target), options, error => {
                cb(error);
                onRemoval();
            });
        }
    };
});

afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
});

function load(filename, overrides = {}) {
    const filepath = path.join(root, 'libs', filename);
    const localRequire = createRequire(filepath);
    const config = { cleanupUploadsAfter: 1 };
    const dependencies = {
        fs: filesystem,
        rimraf: (target, cb) => localRequire('rimraf')(path.resolve(directory, target), error => {
            cb(error);
            onRemoval();
        }),
        '../config': config,
        '../config.js': config,
        './Directories': { data: path.join(directory, 'data') },
        './logger': { info() {}, debug() {}, warn() {} },
        './odmRunner': {},
        './odmInfo': { filterOptions: (options, cb) => cb(null, []) },
        './processRunner': {},
        './S3': {},
        './utils': {},
        './appRoot': {},
        './ProgressReceiver': {},
        './storage': { files: () => () => {} },
        './ziputils': {},
        './Task': {},
        './TaskManager': {},
        ...overrides
    };
    const exported = filename === 'TaskManager.js' ? 'TaskManager' : 'module.exports';
    return vm.runInNewContext(fs.readFileSync(filepath, 'utf8') + '\n;' + exported, {
        module: { exports: {} },
        require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name)
    }, { filename: filepath });
}

function nested(target) {
    const resolved = path.resolve(directory, target);
    fs.mkdirSync(path.join(resolved, 'nested', 'images'), { recursive: true });
    fs.writeFileSync(path.join(resolved, 'nested', 'images', 'image.jpg'), 'image');
    return resolved;
}

function task(initialized = true) {
    return Object.assign(Object.create(load('Task.js').prototype), {
        uuid, initialized, onInitialize: []
    });
}

function manager() {
    return Object.assign(Object.create(load('TaskManager.js').prototype), { tasks: {} });
}

function callbackResult(invoke) {
    return new Promise(resolve => invoke(error => resolve(error)));
}

function failRemoval(error) {
    filesystem.rm = (target, options, cb) => {
        removals.push({ target, options });
        queueMicrotask(() => cb(error));
    };
}

async function upload() {
    nested(path.join('tmp', uuid));
    let initialized;
    const initialization = new Promise(resolve => { initialized = resolve; });
    const responses = [];
    const processing = [];
    const uploads = load('taskNew.js', {
        './TaskManager': { singleton: () => ({ addNew() {}, processNextTask: () => processing.push(true) }) },
        './Task': class {
            initialize(done, steps) { initialized({ done, steps }); }
        }
    });
    uploads.createTask({ id: uuid, body: {}, files: ['image.jpg'] }, {
        json: response => responses.push(response)
    });
    return { ...await initialization, responses, processing };
}

test('rimraf is no longer a direct dependency or cleanup import', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.dependencies).not.toHaveProperty('rimraf');
    for (const filename of ['Task.js', 'TaskManager.js', 'taskNew.js']) {
        expect(fs.readFileSync(path.join(root, 'libs', filename), 'utf8')).not.toMatch(/require\(['"]rimraf['"]\)/);
    }
});

for (const initialized of [true, false]) {
    test(`task cleanup removes nested files asynchronously, initialized=${initialized}`, async () => {
        const current = task(initialized);
        const target = nested(current.getProjectFolderPath());
        let completed = 0;
        const result = callbackResult(cb => current.cleanup(error => {
            completed++;
            cb(error);
        }));
        expect(completed).toBe(0);
        if (!initialized) {
            expect(removals).toHaveLength(0);
            expect(current.onInitialize).toHaveLength(1);
            current.onInitialize[0]();
        }
        expect(await result).toBeFalsy();
        expect(completed).toBe(1);
        expect(fs.existsSync(target)).toBe(false);
        expect(removals).toEqual([{ target, options: { recursive: true, force: true } }]);
    });

    test(`task cleanup accepts missing paths, initialized=${initialized}`, async () => {
        const current = task(initialized);
        const result = callbackResult(cb => current.cleanup(cb));
        if (!initialized) current.onInitialize[0]();
        expect(await result).toBeFalsy();
    });

    test(`task cleanup forwards removal errors, initialized=${initialized}`, async () => {
        const error = Object.assign(new Error('Removal denied'), { code: 'EACCES' });
        failRemoval(error);
        const current = task(initialized);
        nested(current.getProjectFolderPath());
        const result = callbackResult(cb => current.cleanup(cb));
        if (!initialized) current.onInitialize[0]();
        expect(await result).toBe(error);
        expect(fs.existsSync(current.getProjectFolderPath())).toBe(true);
    });
}

for (const method of ['removeOrphanedDirectories', 'removeStaleUploads']) {
    function prepare() {
        const parent = method === 'removeStaleUploads' ? 'tmp' : 'data';
        const target = nested(path.join(parent, uuid));
        const kept = nested(path.join(parent, 'not-a-task'));
        fs.writeFileSync(path.join(directory, parent, 'ffff-eeee-dddd-cccc-bbbb'), 'keep');
        const current = manager();
        if (method === 'removeStaleUploads') {
            nested(path.join(parent, 'aaaa-bbbb-cccc-dddd-eeee'));
            const stat = filesystem.stat;
            filesystem.stat = (entry, cb) => stat(entry, (error, stats) => {
                if (stats && path.basename(entry) === uuid) stats.ctime = new Date(0);
                cb(error, stats);
            });
        } else {
            current.tasks['aaaa-bbbb-cccc-dddd-eeee'] = {};
            nested(path.join(parent, 'aaaa-bbbb-cccc-dddd-eeee'));
        }
        return { current, target, kept };
    }

    test(`${method} removes only eligible nested directories`, async () => {
        const { current, target, kept } = prepare();
        expect(await callbackResult(cb => current[method](cb))).toBeFalsy();
        expect(fs.existsSync(target)).toBe(false);
        expect(fs.existsSync(kept)).toBe(true);
        expect(fs.readFileSync(path.join(path.dirname(target), 'ffff-eeee-dddd-cccc-bbbb'), 'utf8')).toBe('keep');
        expect(removals).toHaveLength(1);
        expect(removals[0].options).toEqual({ recursive: true, force: true });
        expect(fs.existsSync(path.join(path.dirname(target), 'aaaa-bbbb-cccc-dddd-eeee'))).toBe(true);
    });

    test(`${method} tolerates a directory disappearing before removal`, async () => {
        const { current } = prepare();
        const remove = filesystem.rm;
        filesystem.rm = (target, options, cb) => {
            fs.rmSync(path.resolve(directory, target), { recursive: true, force: true });
            remove(target, options, cb);
        };
        expect(await callbackResult(cb => current[method](cb))).toBeFalsy();
        expect(removals).toHaveLength(1);
    });

    test(`${method} forwards removal errors`, async () => {
        const { current, target } = prepare();
        const error = Object.assign(new Error('Directory busy'), { code: 'EBUSY' });
        failRemoval(error);
        expect(await callbackResult(cb => current[method](cb))).toBe(error);
        expect(fs.existsSync(target)).toBe(true);
    });
}

for (const failed of [false, true]) {
    test(`task removal updates the task list only after successful cleanup, failed=${failed}`, async () => {
        const current = manager();
        const currentTask = task();
        nested(currentTask.getProjectFolderPath());
        current.tasks[uuid] = currentTask;
        current.cancel = (id, cb) => cb();
        const processing = [];
        current.processNextTask = () => processing.push(true);
        const error = new Error('Removal failed');
        if (failed) failRemoval(error);
        expect(await callbackResult(cb => current.remove(uuid, cb))).toBe(failed ? error : null);
        expect(current.tasks[uuid]).toBe(failed ? currentTask : undefined);
        expect(processing).toHaveLength(failed ? 0 : 1);
    });
}

test('upload retry waits for nested destination cleanup', async () => {
    const target = nested(path.join('data', uuid));
    const { steps, responses } = await upload();
    expect(responses).toEqual([{ uuid }]);
    expect(await callbackResult(steps[0])).toBeFalsy();
    expect(fs.existsSync(target)).toBe(false);
    expect(removals).toEqual([{ target, options: { recursive: true, force: true } }]);
});

test('upload retry accepts a destination that does not exist', async () => {
    const { steps } = await upload();
    expect(await callbackResult(steps[0])).toBeFalsy();
    expect(removals).toHaveLength(0);
});

test('upload retry preserves its initialization error when cleanup fails', async () => {
    const target = nested(path.join('data', uuid));
    const error = new Error('Removal denied');
    failRemoval(error);
    const { steps } = await upload();
    expect((await callbackResult(steps[0])).message).toBe("Directory exists and we couldn't remove it.");
    expect(fs.existsSync(target)).toBe(true);
});

test('upload cleanup accepts a missing destination after the first stat', async () => {
    nested(path.join('data', uuid));
    const target = path.join(directory, 'data', uuid);
    const stat = filesystem.stat;
    let destinationStats = 0;
    filesystem.stat = (entry, cb) => {
        if (entry === target && ++destinationStats === 2) {
            fs.rmSync(target, { recursive: true, force: true });
        }
        stat(entry, cb);
    };
    const { steps } = await upload();
    expect(await callbackResult(steps[0])).toBeFalsy();
});

test('upload cleanup leaves a non-directory destination untouched', async () => {
    fs.mkdirSync(path.join(directory, 'data'));
    const target = path.join(directory, 'data', uuid);
    fs.writeFileSync(target, 'keep');
    const { steps } = await upload();
    expect(await callbackResult(steps[0])).toBeFalsy();
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
    expect(removals).toHaveLength(0);
});

test('failed upload initialization cleans temporary and destination directories without processing', async () => {
    const target = nested(path.join('data', uuid));
    const { done, processing } = await upload();
    const finished = new Promise(resolve => {
        let completed = 0;
        onRemoval = () => {
            if (++completed === 2) resolve();
        };
    });
    done(new Error('Initialization failed'));
    await finished;
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(directory, 'tmp', uuid))).toBe(false);
    expect(processing).toHaveLength(0);
    expect(removals).toHaveLength(2);
});

for (const handler of ['handleInit', 'createTask']) {
    test(`${handler} keeps its error response when background cleanup fails`, async () => {
        nested(path.join('tmp', uuid));
        const error = new Error('Removal denied');
        let finish;
        const finished = new Promise(resolve => { finish = resolve; });
        onRemoval = finish;
        filesystem.rm = (target, options, cb) => {
            removals.push({ target, options });
            queueMicrotask(() => {
                cb(error);
                finish();
            });
        };
        const responses = [];
        const uploads = load('taskNew.js', {
            './odmInfo': { filterOptions: (options, cb) => cb(new Error('Invalid options')) }
        });
        uploads[handler]({ id: uuid, body: { options: [] }, error: 'Invalid options' }, {
            json: response => responses.push(response)
        });
        await finished;
        expect(responses).toEqual([{ error: 'Invalid options' }]);
        expect(removals).toEqual([{ target: path.join('tmp', uuid), options: { recursive: true, force: true } }]);
        expect(fs.existsSync(path.join(directory, 'tmp', uuid))).toBe(true);
    });
}
