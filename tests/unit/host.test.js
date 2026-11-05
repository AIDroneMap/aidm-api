const { test, expect, afterEach, setDefaultTimeout } = require('bun:test');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..', '..');
const indexJs = path.join(root, 'index.js');

// Each test starts the API at least once
setDefaultTimeout(30000);

// An address from the documentation range, which no machine is given (RFC 5737)
const ABSENT_ADDRESS = '192.0.2.1';

const workspaces = [];
const children = [];
const receivers = [];

afterEach(() => {
    children.splice(0).forEach(child => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    workspaces.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
    receivers.splice(0).forEach(socket => {
        try {
            socket.close();
        } catch (e) {
            // The receiver closes its socket itself after a bind error
        }
    });
});

// A working folder for one start of the API: the folders it scans in test
// mode, and a config file that keeps its log out of the repository.
function workspace(extraConfig = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-host-'));
    workspaces.push(dir);
    fs.mkdirSync(path.join(dir, 'tests', 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'));
    const config = Object.assign({ logger: { logDirectory: dir } }, extraConfig);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
    return { dir };
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

// Starts the API in test mode in a child process, on a free port unless the
// arguments name one
async function start(ws, args = []) {
    const port = args.includes('--port') ? null : await freePort();
    const portArgs = port === null ? [] : ['--port', String(port)];
    const child = spawn(process.execPath, [indexJs, '--config', path.join(ws.dir, 'config.json'), '--test']
        .concat(portArgs, args), { cwd: ws.dir, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const api = { child, port, output: '', exit: null };
    child.stdout.on('data', chunk => { api.output += chunk; });
    child.stderr.on('data', chunk => { api.output += chunk; });
    child.on('exit', (code, signal) => { api.exit = { code, signal }; });
    return api;
}

async function started(api, line) {
    await waitFor(() => api.exit || api.output.includes(line));
    if (api.exit) throw new Error('The API stopped: ' + api.output);
}

async function stopped(api) {
    await waitFor(() => api.exit);
    return api.exit;
}

// Resolves true when a TCP connection to the address opens, false when it is refused
function connects(address, port) {
    return new Promise(resolve => {
        const sock = net.connect({ host: address, port });
        sock.setTimeout(3000);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.on('error', () => resolve(false));
    });
}

// An IPv4 address of this machine that is not loopback, when it has one
const externalAddress = Object.values(os.networkInterfaces()).flat()
    .find(a => a && a.family === 'IPv4' && !a.internal);

test('answers /info on loopback with --host 127.0.0.1, and binds the progress receiver there', async () => {
    const ws = workspace();
    const api = await start(ws, ['--host', '127.0.0.1']);
    await started(api, `Server has started on 127.0.0.1:${api.port}`);

    const res = await fetch(`http://127.0.0.1:${api.port}/info`);
    expect(res.status).toBe(200);
    expect((await res.json()).version).toMatch(/^\d+\.\d+\.\d+$/);

    await waitFor(() => api.output.includes('UDP for progress updates'));
    expect(api.output).toContain('Listening on 127.0.0.1:6367 UDP for progress updates');
    expect(api.output).not.toContain('Unrecognized flag');
});

test('takes the host from the config file', async () => {
    const ws = workspace({ host: '127.0.0.1' });
    const api = await start(ws);
    await started(api, `Server has started on 127.0.0.1:${api.port}`);
    expect((await fetch(`http://127.0.0.1:${api.port}/info`)).status).toBe(200);
});

test.skipIf(!externalAddress)('with --host 127.0.0.1 the port is closed on the other addresses of this machine', async () => {
    const ws = workspace();
    const api = await start(ws, ['--host', '127.0.0.1']);
    await started(api, `Server has started on 127.0.0.1:${api.port}`);
    expect(await connects('127.0.0.1', api.port)).toBe(true);
    expect(await connects(externalAddress.address, api.port)).toBe(false);
});

test('without a host, listens on every interface and logs the port only', async () => {
    const ws = workspace();
    const api = await start(ws);
    await started(api, 'Server has started on port ' + api.port);
    expect(api.output).not.toContain(`Server has started on 127.0.0.1`);
    expect(await connects('127.0.0.1', api.port)).toBe(true);
    if (externalAddress) expect(await connects(externalAddress.address, api.port)).toBe(true);
});

test('refuses to start on an address this machine does not have, naming the address and the port', async () => {
    const ws = workspace();
    const api = await start(ws, ['--host', ABSENT_ADDRESS]);
    const exit = await stopped(api);
    expect(exit.code).not.toBe(0);
    expect(api.output).toContain(`Cannot listen on ${ABSENT_ADDRESS}:${api.port}`);
    expect(api.output).not.toContain('Server has started');
});

test('with --port auto, an address this machine does not have fails on the first port without walking the range', async () => {
    const ws = workspace();
    const api = await start(ws, ['--host', ABSENT_ADDRESS, '--port', 'auto']);
    const exit = await stopped(api);
    expect(exit.code).not.toBe(0);
    expect(api.output).toContain(`Cannot listen on ${ABSENT_ADDRESS}:3000`);
    expect(api.output).not.toContain(`Cannot listen on ${ABSENT_ADDRESS}:3001`);
    expect(api.output).not.toContain('Server has started');
});

test('with --port auto, a port in use on the host moves the search to the next port', async () => {
    const ws = workspace();
    const holders = [];
    try {
        // Hold 3000 on loopback, unless something on this machine already does
        const hold = new Promise(resolve => {
            const srv = net.createServer();
            srv.on('error', () => resolve());
            srv.listen(3000, '127.0.0.1', () => { holders.push(srv); resolve(); });
        });
        await hold;
        const api = await start(ws, ['--host', '127.0.0.1', '--port', 'auto']);
        await started(api, 'Server has started on 127.0.0.1:');
        const port = Number(api.output.match(/Server has started on 127\.0\.0\.1:(\d+)/)[1]);
        expect(port).toBeGreaterThan(3000);
        expect((await fetch(`http://127.0.0.1:${port}/info`)).status).toBe(200);
    } finally {
        holders.forEach(srv => srv.close());
    }
});

test('refuses the host flag without an address', async () => {
    const ws = workspace();
    const api = await start(ws, ['--host']);
    const exit = await stopped(api);
    expect(exit.code).not.toBe(0);
    expect(api.output).toContain('The host option (--host, or "host" in the config file) needs an address');
});

test('the help text names the flag and the address the engine sends progress to', async () => {
    const ws = workspace();
    const api = await start(ws, ['--help']);
    expect((await stopped(api)).code).toBe(0);
    expect(api.output).toContain('--host <address>');
    expect(api.output).toContain('The engine sends progress to 127.0.0.1');
});

// Loads the progress receiver with its logger replaced, so the test reads
// the address it logs. Its sockets are closed after each test.
function loadProgressReceiver(lines) {
    const source = fs.readFileSync(path.join(root, 'libs', 'ProgressReceiver.js'), 'utf8');
    const replacements = {
        './logger': { info: line => lines.push(line), warn: line => lines.push(line) },
        dgram: {
            createSocket: options => {
                const socket = dgram.createSocket(options);
                receivers.push(socket);
                return socket;
            }
        }
    };
    const sandbox = {
        module: { exports: {} },
        require: dependency => Object.hasOwn(replacements, dependency) ? replacements[dependency] : require(dependency)
    };
    vm.runInNewContext(source, sandbox, { filename: 'ProgressReceiver.js' });
    return sandbox.module.exports;
}

// Builds a receiver on a free port and waits for its listening line
async function bindReceiver(host) {
    const lines = [];
    const ProgressReceiver = loadProgressReceiver(lines);
    const updates = [];
    const free = dgram.createSocket('udp4');
    await new Promise(resolve => free.bind(0, '127.0.0.1', resolve));
    const port = free.address().port;
    await new Promise(resolve => free.close(resolve));

    const receiver = new ProgressReceiver(host, port);
    receiver.addListener((uuid, progress) => updates.push({ uuid, progress }));
    const line = await waitFor(() => lines.find(l => l.includes('UDP for progress updates')));
    return { line, port, updates };
}

function send(message, address, port) {
    const sock = dgram.createSocket('udp4');
    receivers.push(sock);
    return new Promise((resolve, reject) => sock.send(message, port, address, err => err ? reject(err) : resolve()));
}

test('the progress receiver bound to a host delivers a datagram sent to that host', async () => {
    const r = await bindReceiver('127.0.0.1');
    expect(r.line).toBe(`Listening on 127.0.0.1:${r.port} UDP for progress updates`);
    await send('PGUP/1234/task-uuid/42.5', '127.0.0.1', r.port);
    await waitFor(() => r.updates.length > 0);
    expect(r.updates).toEqual([{ uuid: 'task-uuid', progress: 42.5 }]);
});

test('the progress receiver without a host binds every interface', async () => {
    const r = await bindReceiver('');
    expect(r.line).toBe(`Listening on 0.0.0.0:${r.port} UDP for progress updates`);
    await send('PGUP/1234/task-uuid/7', '127.0.0.1', r.port);
    await waitFor(() => r.updates.length > 0);
    expect(r.updates).toEqual([{ uuid: 'task-uuid', progress: 7 }]);
});

test('the progress receiver bind error stays a warning', async () => {
    const lines = [];
    const ProgressReceiver = loadProgressReceiver(lines);
    new ProgressReceiver(ABSENT_ADDRESS, 6367);
    const line = await waitFor(() => lines.find(l => l.startsWith('Progress listener server error')));
    expect(line).toContain('EADDRNOTAVAIL');
});
