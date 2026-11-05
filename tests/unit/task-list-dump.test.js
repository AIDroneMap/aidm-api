const { test, expect, afterEach, setDefaultTimeout } = require('bun:test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..', '..');
const indexJs = path.join(root, 'index.js');
const source = fs.readFileSync(path.join(root, 'libs', 'TaskManager.js'), 'utf8');

// The kill tests start the API twice
setDefaultTimeout(60000);

const workspaces = [];
const children = [];

afterEach(() => {
    children.splice(0).forEach(child => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    workspaces.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});

function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-task-list-'));
    workspaces.push(dir);
    return dir;
}

async function waitFor(predicate, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const value = await predicate();
        if (value) return value;
        await Bun.sleep(50);
    }
    throw new Error('Timed out');
}

// Loads the task manager with the real file system on a data folder of its
// own. The write goes through fsOverrides, so a test can count or fail it.
function loadManager(dataDir, fsOverrides = {}) {
    const errors = [];
    const writes = [];
    const realFs = require('fs');
    const sandboxFs = Object.assign({}, realFs, {
        readdir: (dir, cb) => dir === 'tmp' ? queueMicrotask(() => cb(null, [])) : realFs.readdir(dir, cb),
        writeFile: (file, data, cb) => {
            writes.push(file);
            realFs.writeFile(file, data, cb);
        }
    }, fsOverrides);
    const sandbox = {
        module: { exports: {} },
        require: dependency => {
            const replacements = {
                '../config': { maxRuntime: 0, cleanupTasksAfter: 2880, cleanupUploadsAfter: 2880, parallelQueueProcessing: 1 },
                './logger': { info() {}, debug() {}, warn() {}, error(message) { errors.push(message); } },
                './Task': {},
                './Directories': { data: dataDir },
                './ProgressReceiver': class { addListener() {} },
                './statusCodes': require(path.join(root, 'libs', 'statusCodes')),
                fs: sandboxFs,
                'node-schedule': { scheduleJob() {} }
            };
            return Object.hasOwn(replacements, dependency) ? replacements[dependency] : require(dependency);
        }
    };
    vm.runInNewContext(source, sandbox, { filename: 'TaskManager.js' });
    return new Promise((resolve, reject) => {
        sandbox.module.exports.initialize(error => {
            if (error) reject(error);
            else resolve({ manager: sandbox.module.exports.singleton(), errors, writes });
        });
    });
}

test('a burst of changes leaves one complete file with the last state and no temporary file', async () => {
    const dir = tempDir();
    const { manager, errors, writes } = await loadManager(dir);
    let state = 0;
    manager.tasks = { a: { serialize: () => ({ uuid: 'a', state }) } };

    const answered = [];
    for (let i = 1; i <= 20; i++) {
        state = i;
        answered.push(new Promise(resolve => manager.dumpTaskList(resolve)));
    }
    await Promise.all(answered);

    expect(JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'))).toEqual([{ uuid: 'a', state: 20 }]);
    expect(fs.readdirSync(dir)).toEqual(['tasks.json']);
    // The first change writes at once, the other nineteen share one more write
    expect(writes.length).toBe(2);
    expect(errors).toEqual([]);
});

test('a call during a write is answered after the write that holds its change', async () => {
    const dir = tempDir();
    const { manager } = await loadManager(dir);
    let state = 'first';
    manager.tasks = { a: { serialize: () => ({ uuid: 'a', state }) } };
    const file = path.join(dir, 'tasks.json');

    const first = new Promise(resolve => manager.dumpTaskList(resolve));
    state = 'second';
    let seen;
    const second = new Promise(resolve => manager.dumpTaskList(() => {
        seen = JSON.parse(fs.readFileSync(file, 'utf8'))[0].state;
        resolve();
    }));
    await Promise.all([first, second]);
    expect(seen).toBe('second');
});

test('a failing write is logged, answers the caller and leaves the previous list', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'tasks.json');
    let refuse = true;
    const { manager, errors } = await loadManager(dir, {
        rename: (from, to, cb) => refuse ? queueMicrotask(() => cb(new Error('rename refused'))) : fs.rename(from, to, cb)
    });
    fs.writeFileSync(file, '[{"uuid":"before"}]');
    manager.tasks = { a: { serialize: () => ({ uuid: 'after' }) } };

    await new Promise(resolve => manager.dumpTaskList(resolve));

    expect(errors).toEqual(['Could not dump tasks: rename refused']);
    expect(fs.readFileSync(file, 'utf8')).toBe('[{"uuid":"before"}]');
    expect(fs.readdirSync(dir)).toEqual(['tasks.json']);

    // The next change writes again once the cause is gone
    refuse = false;
    await new Promise(resolve => manager.dumpTaskList(resolve));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([{ uuid: 'after' }]);
});

// The API in a child process, in test mode, on a working folder of its own

function workspace(extraConfig = {}) {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'tests', 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'));
    writeConfig(dir, extraConfig);
    return dir;
}

function writeConfig(dir, extraConfig = {}) {
    const config = Object.assign({ logger: { logDirectory: dir } }, extraConfig);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

async function start(dir, args = []) {
    const port = await freePort();
    const child = spawn(process.execPath, [indexJs, '--config', path.join(dir, 'config.json'),
        '--test', '--port', String(port)].concat(args), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const api = { child, port, output: '', exit: null, base: `http://127.0.0.1:${port}` };
    child.stdout.on('data', chunk => { api.output += chunk; });
    child.stderr.on('data', chunk => { api.output += chunk; });
    child.on('exit', (code, signal) => { api.exit = { code, signal }; });
    await waitFor(() => api.exit || api.output.includes('Server has started on port'));
    if (api.exit) throw new Error('The API stopped: ' + api.output);
    return api;
}

// Kills the API with a signal it cannot catch, so no clean stop writes the list
async function kill(api) {
    api.child.kill('SIGKILL');
    await waitFor(() => api.exit);
    expect(api.exit.signal).toBe('SIGKILL');
}

async function createTask(api) {
    const form = new FormData();
    form.append('name', 'kill test');
    form.append('images', new Blob([Buffer.alloc(512, 7)]), 'kill_0001.JPG');
    const res = await fetch(api.base + '/task/new', { method: 'POST', body: form });
    return res.json();
}

async function info(api, uuid) {
    return (await fetch(`${api.base}/task/${uuid}/info`)).json();
}

async function listed(api) {
    return (await (await fetch(api.base + '/task/list')).json()).map(t => t.uuid);
}

// The list on disk, once it holds the task with this status code
function onDisk(dir, uuid, code) {
    return waitFor(() => {
        try {
            const tasks = JSON.parse(fs.readFileSync(path.join(dir, 'tests', 'data', 'tasks.json'), 'utf8'));
            return tasks.some(t => t.uuid === uuid && t.status.code === code);
        } catch (e) {
            return false;
        }
    });
}

test('a running task is listed and queued after a kill', async () => {
    const dir = workspace();
    const first = await start(dir, ['--test_seconds', '60']);
    const { uuid } = await createTask(first);
    expect(uuid).toBeString();
    await waitFor(async () => {
        const i = await info(first, uuid);
        return i.status.code === 20 && i.processingTime > 0;
    });
    await onDisk(dir, uuid, 20);
    await kill(first);

    // No task runs on the second start, so the restored status stays visible
    writeConfig(dir, { parallelQueueProcessing: 0 });
    const second = await start(dir);
    expect(await listed(second)).toEqual([uuid]);
    expect((await info(second, uuid)).status.code).toBe(10);
    expect(fs.existsSync(path.join(dir, 'tests', 'data', uuid, 'images', 'kill_0001.JPG'))).toBe(true);
});

test('a completed task and its results are kept after a kill', async () => {
    const dir = workspace();
    const first = await start(dir);
    const { uuid } = await createTask(first);
    await waitFor(async () => (await info(first, uuid)).status.code === 40);
    await onDisk(dir, uuid, 40);
    await kill(first);

    const second = await start(dir);
    expect(await listed(second)).toEqual([uuid]);
    expect((await info(second, uuid)).status.code).toBe(40);
    expect(fs.existsSync(path.join(dir, 'tests', 'data', uuid, 'all.zip'))).toBe(true);
    const zip = await fetch(`${second.base}/task/${uuid}/download/all.zip`);
    expect(zip.status).toBe(200);
});

test('a request is answered when the task list cannot be written', async () => {
    const dir = workspace();
    // A folder where the temporary file goes makes every write fail
    fs.mkdirSync(path.join(dir, 'tests', 'data', 'tasks.json.tmp'));
    const api = await start(dir);
    const { uuid } = await createTask(api);
    expect(uuid).toBeString();
    await waitFor(() => api.output.includes('Could not dump tasks'));
    expect(await listed(api)).toEqual([uuid]);
});
