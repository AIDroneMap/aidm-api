const { test, expect, afterEach, setDefaultTimeout } = require('bun:test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..', '..');
const indexJs = path.join(root, 'index.js');

// Each test starts the API at least once
setDefaultTimeout(30000);

const workspaces = [];
const children = [];

afterEach(() => {
    children.splice(0).forEach(child => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    workspaces.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});

// A working folder for one start of the API: the folders it scans in test
// mode, and a config file that keeps its log out of the repository.
function workspace(extraConfig = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-socket-'));
    workspaces.push(dir);
    fs.mkdirSync(path.join(dir, 'tests', 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'));
    const config = Object.assign({ logger: { logDirectory: dir } }, extraConfig);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
    return { dir, socket: path.join(dir, 'api.sock') };
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

async function waitFor(predicate, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const value = predicate();
        if (value) return value;
        await Bun.sleep(50);
    }
    throw new Error('Timed out');
}

// Starts the API in test mode in a child process
async function start(ws, args = []) {
    const port = await freePort();
    const child = spawn(process.execPath, [indexJs, '--config', path.join(ws.dir, 'config.json'),
        '--test', '--port', String(port)].concat(args), { cwd: ws.dir, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const api = { child, port, output: '', exit: null };
    child.stdout.on('data', chunk => { api.output += chunk; });
    child.stderr.on('data', chunk => { api.output += chunk; });
    child.on('exit', (code, signal) => { api.exit = { code, signal }; });
    return api;
}

// Waits until the API logs that it listens on the socket, or exits
async function started(api) {
    await waitFor(() => api.exit || api.output.includes('Server has started on socket'));
    if (api.exit) throw new Error('The API stopped: ' + api.output);
}

async function stopped(api) {
    await waitFor(() => api.exit);
    return api.exit;
}

async function infoOverSocket(socketPath) {
    const res = await fetch('http://localhost/info', { unix: socketPath });
    return { status: res.status, body: await res.json() };
}

test('serves the routes on the socket and keeps the port', async () => {
    const ws = workspace();
    const api = await start(ws, ['--socket', ws.socket]);
    await started(api);
    expect(api.output).toContain('Server has started on socket ' + ws.socket);

    const info = await infoOverSocket(ws.socket);
    expect(info.status).toBe(200);
    expect(info.body.version).toMatch(/^\d+\.\d+\.\d+$/);

    const res = await fetch(`http://127.0.0.1:${api.port}/info`);
    expect((await res.json()).version).toBe(info.body.version);
});

test('creates the socket with mode 0600', async () => {
    const ws = workspace();
    const api = await start(ws, ['--socket', ws.socket]);
    await started(api);
    const st = fs.lstatSync(ws.socket);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
});

test('removes the socket on SIGTERM', async () => {
    const ws = workspace();
    const api = await start(ws, ['--socket', ws.socket]);
    await started(api);
    api.child.kill('SIGTERM');
    expect((await stopped(api)).code).toBe(0);
    expect(fs.existsSync(ws.socket)).toBe(false);
});

test('removes a stale socket left by a crash, with the path from the config file', async () => {
    const ws = workspace();
    const first = await start(ws, ['--socket', ws.socket]);
    await started(first);
    first.child.kill('SIGKILL');
    await stopped(first);
    expect(fs.lstatSync(ws.socket).isSocket()).toBe(true);

    fs.writeFileSync(path.join(ws.dir, 'config.json'), JSON.stringify({ logger: { logDirectory: ws.dir }, socket: ws.socket }));
    const second = await start(ws);
    await started(second);
    expect((await infoOverSocket(ws.socket)).status).toBe(200);
});

for (const [kind, make] of [
    ['a regular file', p => fs.writeFileSync(p, 'keep me')],
    ['a folder', p => fs.mkdirSync(p)],
    ['a symbolic link', p => fs.symlinkSync(path.join(path.dirname(p), 'elsewhere.sock'), p)]
]) {
    test(`refuses to start when the path is ${kind}, and leaves it`, async () => {
        const ws = workspace();
        make(ws.socket);
        const before = fs.lstatSync(ws.socket);
        const api = await start(ws, ['--socket', ws.socket]);
        const exit = await stopped(api);
        expect(exit.code).not.toBe(0);
        expect(api.output).toContain(`Cannot listen on socket ${ws.socket}: the path exists and is not a socket`);
        const after = fs.lstatSync(ws.socket);
        expect(after.ino).toBe(before.ino);
        if (before.isFile()) expect(fs.readFileSync(ws.socket, 'utf8')).toBe('keep me');
    });
}

test('a stop leaves alone a socket that another listener has put at the path', async () => {
    const { listen } = require('../../libs/taskApiSocket');
    const ws = workspace();
    const open = name => new Promise((resolve, reject) => {
        listen((req, res) => res.end(name), ws.socket, (err, s) => err ? reject(err) : resolve(s));
    });

    const first = await open('first');
    const second = await open('second');
    const replacement = fs.lstatSync(ws.socket).ino;

    first.close();
    expect(fs.lstatSync(ws.socket).ino).toBe(replacement);
    expect(await (await fetch('http://localhost/', { unix: ws.socket })).text()).toBe('second');

    second.close();
    expect(fs.existsSync(ws.socket)).toBe(false);
});

test('refuses the socket option on Windows', () => {
    const { checkOption } = require('../../libs/taskApiSocket');
    const err = checkOption('/run/task-api.sock', 'win32');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('not supported on Windows');
    expect(checkOption('/run/task-api.sock', 'linux')).toBe(null);
    expect(checkOption('/run/task-api.sock', 'darwin')).toBe(null);
});

test('refuses the socket flag without a path', async () => {
    const ws = workspace();
    const api = await start(ws, ['--socket']);
    const exit = await stopped(api);
    expect(exit.code).not.toBe(0);
    expect(api.output).toContain('The socket option needs a path');
});
