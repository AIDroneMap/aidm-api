#!/usr/bin/env node
/*
Compatibility test harness for the AIDM API.

Starts the API in test mode, calls every endpoint, normalises values that
change between runs and compares the responses with the golden files in
tests/compat/golden/. See tests/compat/README.md.

Plain CommonJS, no dependencies. Runs on Node.js 14 and on Bun.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const GOLDEN_DIR = path.join(__dirname, 'golden');
const SERVER_READY_TIMEOUT = 30000;
const TASK_TIMEOUT = 30000;
const HOOK_TIMEOUT = 10000;
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const UNKNOWN_UUID_2 = '00000000-0000-4000-8000-000000000001';
const CUSTOM_UUID = '5f0e6a1c-3b2d-4c5e-8f7a-1b2c3d4e5f60';
const FINAL_STATUS = [30, 40, 50];

// ---------------------------------------------------------------------------
// Small helpers

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeout, interval) {
    const end = Date.now() + timeout;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > end) return null;
        await sleep(interval || 100);
    }
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

// Seeded generator (mulberry32), so generated files are the same on every run
function prng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function seededBytes(label, length) {
    const rand = prng(parseInt(sha256(Buffer.from(label)).slice(0, 8), 16));
    const buf = Buffer.alloc(length);
    for (let i = 0; i < length; i++) buf[i] = Math.floor(rand() * 256);
    return buf;
}

function rmrf(target) {
    let st;
    try {
        st = fs.lstatSync(target);
    } catch (e) {
        return;
    }
    if (st.isSymbolicLink()) {
        // A junction on Windows can need rmdir instead of unlink
        try { fs.unlinkSync(target); } catch (e) { try { fs.rmdirSync(target); } catch (e2) { /* ignore */ } }
    } else if (st.isDirectory()) {
        fs.readdirSync(target).forEach(name => rmrf(path.join(target, name)));
        try { fs.rmdirSync(target); } catch (e) { /* ignore */ }
    } else {
        try { fs.unlinkSync(target); } catch (e) { /* ignore */ }
    }
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = http.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

// ---------------------------------------------------------------------------
// ZIP files: builder (stored entries) and central directory reader

const CRC_TABLE = (function () {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    entries.forEach(entry => {
        const name = Buffer.from(entry.name, 'utf8');
        const crc = crc32(entry.data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0, 6);
        lh.writeUInt16LE(0, 8);
        lh.writeUInt16LE(0, 10);
        lh.writeUInt16LE(33, 12); // 1980-01-01
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(entry.data.length, 18);
        lh.writeUInt32LE(entry.data.length, 22);
        lh.writeUInt16LE(name.length, 26);
        lh.writeUInt16LE(0, 28);
        locals.push(lh, name, entry.data);

        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0, 8);
        ch.writeUInt16LE(0, 10);
        ch.writeUInt16LE(0, 12);
        ch.writeUInt16LE(33, 14);
        ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(entry.data.length, 20);
        ch.writeUInt32LE(entry.data.length, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt16LE(0, 30);
        ch.writeUInt16LE(0, 32);
        ch.writeUInt16LE(0, 34);
        ch.writeUInt16LE(0, 36);
        ch.writeUInt32LE(0, 38);
        ch.writeUInt32LE(offset, 42);
        centrals.push(ch, name);

        offset += lh.length + name.length + entry.data.length;
    });
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat(locals.concat([cd, eocd]));
}

// Returns [{name, size}] from the central directory, or null if not a zip
function readZipEntries(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) return null;
    const count = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) return null;
        const size = buf.readUInt32LE(pos + 24);
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
        entries.push({ name, size });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// ---------------------------------------------------------------------------
// HTTP client and request bodies

function httpRequest(port, opts) {
    return new Promise((resolve, reject) => {
        const headers = Object.assign({}, opts.headers || {});
        if (opts.body) headers['Content-Length'] = opts.body.length;
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: opts.method,
            path: opts.path,
            headers,
            agent: false
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('request timed out: ' + opts.method + ' ' + opts.path)));
        req.end(opts.body);
    });
}

const BOUNDARY = '----aidmcompatboundary7MA4YWxkTrZu0gW';

function buildMultipart(fields, files) {
    const parts = [];
    Object.keys(fields || {}).forEach(k => {
        parts.push(Buffer.from('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n'));
        parts.push(Buffer.from(String(fields[k])));
        parts.push(Buffer.from('\r\n'));
    });
    (files || []).forEach(f => {
        parts.push(Buffer.from('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="' + f.field + '"; filename="' + f.name +
            '"\r\nContent-Type: application/octet-stream\r\n\r\n'));
        parts.push(f.data);
        parts.push(Buffer.from('\r\n'));
    });
    parts.push(Buffer.from('--' + BOUNDARY + '--\r\n'));
    return Buffer.concat(parts);
}

function buildUrlEncoded(fields) {
    return Object.keys(fields).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(fields[k]))).join('&');
}

// Turns a step spec into {method, path, headers, body, desc}
function buildRequest(spec) {
    const headers = {};
    const extraHeaders = {};
    Object.keys(spec.headers || {}).forEach(k => { headers[k] = spec.headers[k]; extraHeaders[k] = spec.headers[k]; });
    let body;
    let desc;
    if (spec.fields || spec.files) {
        body = buildMultipart(spec.fields, spec.files);
        headers['Content-Type'] = 'multipart/form-data; boundary=' + BOUNDARY;
        desc = {
            multipart: {
                fields: spec.fields || {},
                files: (spec.files || []).map(f => f.field + ': ' + f.name + ' (' + f.data.length + ' bytes)')
            }
        };
    } else if (spec.urlencoded) {
        body = Buffer.from(buildUrlEncoded(spec.urlencoded));
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        desc = { urlencoded: spec.urlencoded };
    } else if (spec.json !== undefined) {
        body = Buffer.from(JSON.stringify(spec.json));
        headers['Content-Type'] = 'application/json';
        desc = { json: spec.json };
    } else if (spec.raw !== undefined) {
        body = Buffer.from(spec.raw);
        headers['Content-Type'] = spec.contentType;
        desc = { raw: spec.raw, contentType: spec.contentType };
    }
    const request = { method: spec.method, path: spec.path };
    if (Object.keys(extraHeaders).length) request.headers = extraHeaders;
    if (desc) request.body = desc;
    return { method: spec.method, path: spec.path, headers, body, entry: request };
}

// ---------------------------------------------------------------------------
// Response description and normalisation

const KEPT_HEADERS = ['content-type', 'content-disposition', 'content-length', 'access-control-allow-origin'];

function describeResponse(res, spec) {
    const ct = String(res.headers['content-type'] || '').toLowerCase();
    const urlPath = spec.path.split('?')[0];
    const out = { status: res.status, headers: {}, body: null };
    const isJson = ct.indexOf('application/json') === 0 && !spec.hashOnly;
    const isZip = ct.indexOf('application/zip') === 0;
    let body = null;

    if (res.body.length === 0) {
        body = null;
    } else if (isJson) {
        try {
            body = JSON.parse(res.body.toString('utf8'));
        } catch (e) {
            body = { text: res.body.toString('utf8') };
        }
        if (urlPath === '/info' && body && typeof body === 'object') {
            ['totalMemory', 'availableMemory', 'cpuCores'].forEach(k => {
                if (typeof body[k] === 'number') body[k] = '<number>';
            });
            // The API version changes with every release, not with the runtime
            if (typeof body.version === 'string' && /^\d+\.\d+\.\d+$/.test(body.version)) body.version = '<version>';
        }
    } else if (isZip) {
        const entries = readZipEntries(res.body);
        if (entries) {
            body = {
                zip: {
                    count: entries.length,
                    entries: entries.map(e => e.name.slice(-1) === '/' ? e.name : e.name + ' ' + e.size).sort()
                }
            };
        } else {
            body = { sha256: sha256(res.body), length: res.body.length };
        }
    } else {
        body = { sha256: sha256(res.body), length: res.body.length };
        if (ct.indexOf('text/html') === 0 && res.body.length <= 512) body.text = res.body.toString('utf8');
    }

    KEPT_HEADERS.forEach(name => {
        if (res.headers[name] === undefined) return;
        let value = res.headers[name];
        if (name === 'content-length') {
            if (isZip) value = '<number>';
            else if (isJson && String(res.body.length) === String(value)) value = '<body-length>';
        }
        out.headers[name] = value;
    });
    out.body = body;
    return out;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;

function makeNormaliser(ports) {
    const uuids = new Map();
    const literal = new Set([UNKNOWN_UUID, UNKNOWN_UUID_2]);

    function str(s) {
        s = s.replace(UUID_RE, m => {
            const key = m.toLowerCase();
            if (literal.has(key)) return m;
            if (!uuids.has(key)) uuids.set(key, '<uuid-' + (uuids.size + 1) + '>');
            return uuids.get(key);
        });
        s = s.replace(ISO_DATE_RE, '<date>');
        ports.forEach(p => {
            s = s.replace(new RegExp(':' + p + '(?![0-9])', 'g'), ':<port>');
        });
        return s;
    }

    function walk(v, key) {
        if (typeof v === 'string') return str(v);
        if (Array.isArray(v)) return v.map(x => walk(x));
        if (v && typeof v === 'object') {
            const out = {};
            Object.keys(v).forEach(k => { out[k] = walk(v[k], k); });
            return out;
        }
        if (key === 'dateCreated' && v !== undefined && v !== null) return '<date>';
        if (key === 'processingTime' && typeof v === 'number' && v >= 0) return '<number>';
        return v;
    }

    return walk;
}

// ---------------------------------------------------------------------------
// Line diff

function diffText(expected, actual) {
    const a = expected.split('\n');
    const b = actual.split('\n');
    const m = a.length;
    const n = b.length;
    const ops = [];
    if (m * n > 16000000) {
        a.forEach(l => ops.push(['-', l]));
        b.forEach(l => ops.push(['+', l]));
    } else {
        const dp = [];
        for (let i = 0; i <= m; i++) dp.push(new Int32Array(n + 1));
        for (let i = m - 1; i >= 0; i--) {
            for (let j = n - 1; j >= 0; j--) {
                dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < m && j < n) {
            if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
            else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
            else { ops.push(['+', b[j]]); j++; }
        }
        while (i < m) ops.push(['-', a[i++]]);
        while (j < n) ops.push(['+', b[j++]]);
    }

    const CONTEXT = 3;
    const show = new Array(ops.length).fill(false);
    ops.forEach((op, idx) => {
        if (op[0] === ' ') return;
        for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) show[k] = true;
    });
    const lines = ['--- expected (golden)', '+++ actual'];
    let gap = false;
    ops.forEach((op, idx) => {
        if (!show[idx]) { gap = true; return; }
        if (gap) { lines.push('@@ ...'); gap = false; }
        lines.push(op[0] + ' ' + op[1]);
    });
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tools

function hasTool(name, appDir) {
    let cmd = name;
    const bundled = path.join(appDir, 'apps', name === '7z' ? '7z' : 'unzip', name === '7z' ? '7z.exe' : 'unzip.exe');
    if (fs.existsSync(bundled)) cmd = path.resolve(bundled);
    try {
        return spawnSync(cmd, ['--help']).status === 0;
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Copy of the app, one per scenario

function copyApp(src, dest) {
    const rootSkip = ['node_modules', 'tmp', 'data', '.worktrees'];
    const testsData = path.join(src, 'tests', 'data');

    function copy(from, to, isRoot) {
        fs.mkdirSync(to, { recursive: true });
        fs.readdirSync(from).forEach(name => {
            if (name === '.git') return;
            if (isRoot && rootSkip.indexOf(name) !== -1) return;
            const f = path.join(from, name);
            const t = path.join(to, name);
            const st = fs.lstatSync(f);
            if (path.resolve(from) === path.resolve(testsData) && name !== '.gitignore') return;
            if (st.isSymbolicLink()) {
                try { fs.symlinkSync(fs.readlinkSync(f), t); } catch (e) { /* ignore broken links */ }
            } else if (st.isDirectory()) {
                copy(f, t, false);
            } else {
                fs.copyFileSync(f, t);
                try { fs.chmodSync(t, st.mode); } catch (e) { /* ignore */ }
            }
        });
    }

    copy(src, dest, true);
    fs.mkdirSync(path.join(dest, 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(dest, 'tests', 'data'), { recursive: true });
    const nm = path.join(src, 'node_modules');
    if (fs.existsSync(nm)) {
        fs.symlinkSync(path.resolve(nm), path.join(dest, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
}

function resolveCommand(cmd, copyDir) {
    const first = cmd[0];
    if (!path.isAbsolute(first)) {
        const inside = path.join(copyDir, first);
        try {
            if (fs.statSync(inside).isFile()) return [inside].concat(cmd.slice(1));
        } catch (e) { /* not inside the copy */ }
    }
    return cmd;
}

// Finds a program on the current PATH. A name with a path separator is returned as it is.
function findOnPath(name) {
    if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1) return name;
    const win = process.platform === 'win32';
    const names = win && !/\.[^.\\/]+$/.test(name) ? [name + '.exe', name] : [name];
    const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(d => d.length);
    for (const dir of dirs) {
        for (const n of names) {
            const full = path.join(dir, n);
            try {
                if (fs.statSync(full).isFile()) return full;
            } catch (e) { /* not here */ }
        }
    }
    throw new Error('Cannot find "' + name + '" on PATH');
}

// A copy of the environment in which unzip and 7z cannot be found. On Linux
// and macOS, PATH is one empty folder. It cannot be an empty string: Bun then
// falls back to a default search path that includes /usr/bin. On Windows PATH
// holds only the system folders, which have neither program.
let emptyDir = null;
function envWithoutTools() {
    const env = Object.assign({}, process.env);
    Object.keys(env).forEach(k => { if (k.toLowerCase() === 'path') delete env[k]; });
    if (process.platform === 'win32') {
        const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
        env.PATH = path.join(root, 'system32') + ';' + root;
        env.Path = env.PATH;
    } else {
        if (!emptyDir) {
            emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-compat-empty-'));
            process.on('exit', () => { try { fs.rmdirSync(emptyDir); } catch (e) { /* ignore */ } });
        }
        env.PATH = emptyDir;
    }
    return env;
}

// Removes the unzip and 7z programs that ship inside a Windows release folder
function removeBundledTools(appDir) {
    ['7z/7z.exe', 'unzip/unzip.exe'].forEach(f => {
        try { fs.unlinkSync(path.join(appDir, 'apps', f)); } catch (e) { /* not there */ }
    });
}

// ---------------------------------------------------------------------------
// Server process

function startServer(command, copyDir, port, flags, noTools) {
    const full = resolveCommand(command, copyDir);
    let env = process.env;
    if (noTools) {
        // Find the program first, because the new PATH cannot find it
        full[0] = findOnPath(full[0]);
        env = envWithoutTools();
    }
    const args = full.slice(1).concat(['--test', '--port', String(port)], flags);
    const server = { lines: [], exited: false, exitInfo: null, child: null };
    const keep = chunk => {
        String(chunk).split(/\r?\n/).forEach(l => { if (l.length) server.lines.push(l); });
        if (server.lines.length > 500) server.lines.splice(0, server.lines.length - 500);
    };
    let child;
    try {
        child = spawn(full[0], args, { cwd: copyDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
        server.exited = true;
        server.exitInfo = 'spawn failed: ' + e.message;
        server.lines.push(server.exitInfo);
        return server;
    }
    server.child = child;
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', e => {
        server.exited = true;
        server.exitInfo = 'process error: ' + e.message;
        server.lines.push(server.exitInfo);
    });
    child.on('exit', (code, signal) => {
        server.exited = true;
        server.exitInfo = 'exited with code ' + code + ' signal ' + signal;
    });
    return server;
}

async function stopServer(server) {
    if (!server.child || server.exited) return;
    try { server.child.kill(); } catch (e) { /* ignore */ }
    let ok = await waitFor(() => server.exited, 10000, 50);
    if (!ok) {
        try { server.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        await waitFor(() => server.exited, 5000, 50);
    }
    // Give the OS time to release the sockets (the API always binds UDP 6367)
    await sleep(process.platform === 'win32' ? 1000 : 300);
}

async function waitReady(server, port) {
    const ok = await waitFor(async () => {
        if (server.exited) throw new Error('Server stopped before it was ready (' + server.exitInfo + ')');
        try {
            await httpRequest(port, { method: 'GET', path: '/info' });
            return true;
        } catch (e) {
            return false;
        }
    }, SERVER_READY_TIMEOUT, 200);
    if (!ok) throw new Error('Server did not answer on /info within ' + SERVER_READY_TIMEOUT / 1000 + ' s');
}

// ---------------------------------------------------------------------------
// Local helper servers (zip files and webhook)

function startZipServer(zipFiles) {
    return new Promise((resolve, reject) => {
        const srv = http.createServer((req, res) => {
            const f = zipFiles[req.url];
            if (f) {
                res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': f.length });
                res.end(f);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            }
        });
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }));
    });
}

function startHookServer() {
    return new Promise((resolve, reject) => {
        const hook = { calls: [], answers: [], server: null, port: 0 };
        hook.reset = answers => { hook.calls = []; hook.answers = answers.slice(); };
        hook.server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                const status = hook.answers.length ? hook.answers.shift() : 200;
                let body;
                const text = Buffer.concat(chunks).toString('utf8');
                try { body = JSON.parse(text); } catch (e) { body = { text }; }
                hook.calls.push({
                    method: req.method,
                    path: req.url,
                    contentType: req.headers['content-type'],
                    body,
                    status
                });
                res.writeHead(status, { 'Content-Type': 'text/plain' });
                res.end(status === 200 ? 'ok' : 'error');
            });
        });
        hook.server.on('error', reject);
        hook.server.listen(0, '127.0.0.1', () => { hook.port = hook.server.address().port; resolve(hook); });
    });
}

// ---------------------------------------------------------------------------
// Scenario context

function makeContext(env, port) {
    const entries = [];
    const normalise = makeNormaliser([port, env.zipPort, env.hook.port]);
    const ctx = {
        port,
        entries,
        token: '',
        hook: env.hook,
        hookUrl: 'http://127.0.0.1:' + env.hook.port + '/hook',
        zipUrl: p => 'http://127.0.0.1:' + env.zipPort + p,
        skipped: []
    };

    ctx.call = async function (name, spec) {
        const req = buildRequest(spec);
        const res = await httpRequest(port, { method: req.method, path: req.path, headers: req.headers, body: req.body });
        const reqEntry = normalise(req.entry);
        const resEntry = normalise(describeResponse(res, spec));
        entries.push({ step: name, request: reqEntry, response: resEntry });
        let json = null;
        try { json = JSON.parse(res.body.toString('utf8')); } catch (e) { /* not JSON */ }
        return { res, json };
    };

    // Records a step that did not come from a call to the API (the webhook calls).
    // It shares the uuid numbering with the other steps.
    ctx.record = (name, request, response) => {
        entries.push({ step: name, request: normalise(request), response: normalise(response) });
    };

    ctx.get = (name, p, extra) => ctx.call(name, Object.assign({ method: 'GET', path: p }, extra || {}));
    ctx.post = (name, p, extra) => ctx.call(name, Object.assign({ method: 'POST', path: p }, extra || {}));

    // Request that is not recorded (used to wait for task states)
    ctx.quiet = async function (p) {
        const sep = p.indexOf('?') === -1 ? '?' : '&';
        const full = ctx.token ? p + sep + 'token=' + ctx.token : p;
        const res = await httpRequest(port, { method: 'GET', path: full });
        try { return JSON.parse(res.body.toString('utf8')); } catch (e) { return null; }
    };

    ctx.waitFinal = async function (uuid) {
        const info = await waitFor(async () => {
            const i = await ctx.quiet('/task/' + uuid + '/info');
            return i && i.status && FINAL_STATUS.indexOf(i.status.code) !== -1 ? i : null;
        }, TASK_TIMEOUT, 100);
        if (!info) throw new Error('Task ' + uuid + ' did not reach a final status within ' + TASK_TIMEOUT / 1000 + ' s');
        return info;
    };

    // Records a task creation step and returns the uuid
    ctx.newTask = async function (name, p, spec) {
        const r = await ctx.post(name, p, spec);
        return r.json && r.json.uuid ? r.json.uuid : null;
    };

    ctx.images = function (prefix, count) {
        const files = [];
        for (let i = 1; i <= count; i++) {
            const name = prefix + '_' + String(i).padStart(4, '0') + '.JPG';
            files.push({ field: 'images', name, data: seededBytes(name, 300 + i) });
        }
        return files;
    };

    ctx.skip = function (what, reason) {
        ctx.skipped.push(what + ': ' + reason);
    };

    return ctx;
}

const OPT_RES = JSON.stringify([{ name: 'orthophoto-resolution', value: '2.5' }]);
const taskPath = (uuid, suffix) => '/task/' + uuid + suffix;

// ---------------------------------------------------------------------------
// Scenarios

const scenarios = [];

scenarios.push({
    name: 'default',
    flags: () => [],
    run: async function (c) {
        // Static files and documentation
        await c.get('static index page', '/');
        await c.get('swagger.json', '/swagger.json', { hashOnly: true });
        await c.get('static file not found', '/does-not-exist.html');
        await c.call('cors preflight', {
            method: 'OPTIONS',
            path: '/task/list',
            headers: { Origin: 'http://example.com', 'Access-Control-Request-Method': 'GET' }
        });

        // Node information and auth stubs
        await c.get('info', '/info');
        await c.get('info with the debug unauthorized flag', '/info?_debugUnauthorized=1');
        await c.get('options', '/options');
        await c.get('auth info', '/auth/info');
        await c.post('auth login', '/auth/login');
        await c.post('auth register', '/auth/register');
        await c.get('task list (empty)', '/task/list');

        // One task, uploaded in one request
        const a = await c.newTask('task new: two images', '/task/new', {
            fields: { name: 'compat task', options: OPT_RES },
            files: c.images('a', 2)
        });
        await c.waitFinal(a);
        await c.get('task info', taskPath(a, '/info'));
        await c.get('task info with_output=2', taskPath(a, '/info?with_output=2'));
        await c.get('task output', taskPath(a, '/output'));
        await c.get('task output line=3', taskPath(a, '/output?line=3'));
        await c.get('task output line past the end', taskPath(a, '/output?line=100000'));
        await c.get('task list', '/task/list');

        // Downloads
        await c.get('download all.zip', taskPath(a, '/download/all.zip'));
        await c.get('download invalid asset: orthophoto.tif', taskPath(a, '/download/orthophoto.tif'));
        await c.get('download invalid asset: ALL.ZIP', taskPath(a, '/download/ALL.ZIP'));
        await c.get('download unknown task', taskPath(UNKNOWN_UUID, '/download/all.zip'));
        await c.get('task info unknown task', taskPath(UNKNOWN_UUID, '/info'));
        await c.get('task output unknown task', taskPath(UNKNOWN_UUID, '/output'));

        // Other creation parameters
        const b = await c.newTask('task new: unknown option, outputs, skipPostProcessing, empty name', '/task/new', {
            fields: {
                name: '',
                options: JSON.stringify([{ name: 'orthophoto-resolution', value: '1' }, { name: 'no-such-option', value: 'x' }]),
                skipPostProcessing: 'true',
                outputs: JSON.stringify(['images.json', 'odm_report']),
                dateCreated: '1600000000000'
            },
            files: c.images('b', 1)
        });
        await c.waitFinal(b);
        await c.get('info of task with outputs', taskPath(b, '/info'));
        await c.get('download all.zip with custom outputs', taskPath(b, '/download/all.zip'));

        const g = await c.newTask('task new: GCP txt file next to an image', '/task/new', {
            fields: { name: 'gcp task' },
            files: c.images('g', 1).concat([{ field: 'images', name: 'gcp_list.txt', data: Buffer.from('EPSG:4326\n1 2 3 4 5 image.jpg\n') }])
        });
        await c.waitFinal(g);
        await c.get('info of task with GCP file', taskPath(g, '/info'));

        const z = await c.newTask('task new: uploaded images.zip is not extracted', '/task/new', {
            fields: { name: 'zip upload' },
            files: c.images('z', 1).concat([{ field: 'images', name: 'images.zip', data: buildZip([{ name: 'inner.jpg', data: seededBytes('inner', 100) }]) }])
        });
        await c.waitFinal(z);
        await c.get('info of task with uploaded images.zip', taskPath(z, '/info'));

        const s = await c.newTask('task new: set-uuid header', '/task/new', {
            headers: { 'set-uuid': CUSTOM_UUID },
            fields: { name: 'custom uuid' },
            files: c.images('s', 1)
        });
        await c.waitFinal(s);
        await c.get('info of task with set-uuid', taskPath(s, '/info'));
        await c.post('task new: set-uuid already in use', '/task/new', {
            headers: { 'set-uuid': CUSTOM_UUID },
            fields: { name: 'custom uuid again' },
            files: c.images('s', 1)
        });
        await c.post('task new: invalid set-uuid', '/task/new', {
            headers: { 'set-uuid': 'not-a-uuid' },
            fields: { name: 'bad uuid' },
            files: c.images('s', 1)
        });

        // Errors on task creation
        await c.post('task new error: options is not JSON', '/task/new', {
            fields: { name: 'bad options', options: '{not json' },
            files: c.images('e', 1)
        });
        await c.post('task new error: option value out of range', '/task/new', {
            fields: { name: 'bad value', options: JSON.stringify([{ name: 'orthophoto-resolution', value: 'abc' }]) },
            files: c.images('e', 1)
        });
        await c.post('task new error: option value not in enum', '/task/new', {
            fields: { name: 'bad enum', options: JSON.stringify([{ name: 'end-with', value: 'nowhere' }]) },
            files: c.images('e', 1)
        });
        await c.post('task new error: no files', '/task/new', { fields: { name: 'no files' } });
        await c.post('task new error: unexpected file field', '/task/new', {
            fields: { name: 'wrong field' },
            files: [{ field: 'photos', name: 'x.JPG', data: seededBytes('x', 50) }]
        });

        // zipurl failures that do not need unzip
        const zr = await c.newTask('task new: zipurl connection refused', '/task/new', {
            fields: { name: 'zipurl refused', zipurl: 'http://127.0.0.1:1/x.zip' }
        });
        await c.waitFinal(zr);
        await c.get('info of zipurl connection refused', taskPath(zr, '/info'));
        const zn = await c.newTask('task new: zipurl is not a URL', '/task/new', {
            fields: { name: 'zipurl invalid', zipurl: 'not-a-url' }
        });
        await c.waitFinal(zn);
        await c.get('info of zipurl not a URL', taskPath(zn, '/info'));

        // Chunked upload
        const init = await c.post('chunked: init', '/task/new/init', { fields: { name: 'chunked task', options: OPT_RES } });
        const ck = init.json && init.json.uuid;
        await c.post('chunked: upload 1', '/task/new/upload/' + ck, { files: c.images('k', 1) });
        await c.post('chunked: upload 2', '/task/new/upload/' + ck, { files: c.images('k2', 1) });
        await c.post('chunked: upload without files', '/task/new/upload/' + ck, { fields: { note: 'no files here' } });
        const commit = await c.post('chunked: commit', '/task/new/commit/' + ck);
        await c.waitFinal(commit.json && commit.json.uuid);
        await c.get('chunked: info', taskPath(ck, '/info'));
        await c.post('chunked: commit again', '/task/new/commit/' + ck);
        await c.post('chunked: upload after commit', '/task/new/upload/' + ck, { files: c.images('k3', 1) });
        await c.post('chunked: upload to unknown uuid', '/task/new/upload/' + UNKNOWN_UUID, { files: c.images('k', 1) });
        await c.post('chunked: commit unknown uuid', '/task/new/commit/' + UNKNOWN_UUID);
        await c.post('chunked: init with invalid options', '/task/new/init', { fields: { name: 'bad', options: JSON.stringify([{ name: 'end-with', value: 'nowhere' }]) } });
        await c.post('chunked: init with invalid set-uuid', '/task/new/init', { headers: { 'set-uuid': 'nope' }, fields: { name: 'bad' } });
        const init2 = await c.post('chunked: init with set-uuid and no fields', '/task/new/init', {
            headers: { 'set-uuid': 'a1b2c3d4-0000-4000-9000-000000000001' }
        });
        await c.post('chunked: commit without files', '/task/new/commit/' + (init2.json && init2.json.uuid));

        // Cancel, restart and remove
        await c.post('cancel unknown uuid (urlencoded)', '/task/cancel', { urlencoded: { uuid: UNKNOWN_UUID } });
        await c.post('cancel unknown uuid (json)', '/task/cancel', { json: { uuid: UNKNOWN_UUID } });
        await c.post('cancel missing uuid (urlencoded)', '/task/cancel', { urlencoded: { other: '1' } });
        await c.post('cancel missing uuid (json)', '/task/cancel', { json: {} });
        await c.post('cancel malformed json', '/task/cancel', { raw: '{"uuid": ', contentType: 'application/json' });
        await c.post('restart unknown uuid (urlencoded)', '/task/restart', { urlencoded: { uuid: UNKNOWN_UUID } });
        await c.post('restart unknown uuid (json)', '/task/restart', { json: { uuid: UNKNOWN_UUID } });
        await c.post('restart missing uuid (urlencoded)', '/task/restart', { urlencoded: { other: '1' } });
        await c.post('restart missing uuid (json)', '/task/restart', { json: {} });
        await c.post('remove unknown uuid (urlencoded)', '/task/remove', { urlencoded: { uuid: UNKNOWN_UUID } });
        await c.post('remove unknown uuid (json)', '/task/remove', { json: { uuid: UNKNOWN_UUID } });
        await c.post('remove missing uuid (urlencoded)', '/task/remove', { urlencoded: { other: '1' } });
        await c.post('remove missing uuid (json)', '/task/remove', { json: {} });

        await c.post('cancel finished task (urlencoded)', '/task/cancel', { urlencoded: { uuid: a } });
        await c.get('info after cancel', taskPath(a, '/info'));
        await c.post('cancel again (json)', '/task/cancel', { json: { uuid: a } });
        await c.post('restart (json, no options)', '/task/restart', { json: { uuid: a } });
        await c.waitFinal(a);
        await c.get('info after restart', taskPath(a, '/info'));
        await c.get('output after restart', taskPath(a, '/output'));
        await c.post('restart while finished (urlencoded, options as JSON string)', '/task/restart', {
            urlencoded: { uuid: a, options: JSON.stringify([{ name: 'orthophoto-resolution', value: '7' }]) }
        });
        await c.waitFinal(a);
        await c.get('info after restart with options (urlencoded)', taskPath(a, '/info'));
        await c.post('restart (json, options as array)', '/task/restart', {
            json: { uuid: a, options: [{ name: 'orthophoto-resolution', value: '9' }] }
        });
        await c.waitFinal(a);
        await c.get('info after restart with options (json)', taskPath(a, '/info'));
        await c.post('restart with invalid options', '/task/restart', {
            json: { uuid: a, options: [{ name: 'end-with', value: 'nowhere' }] }
        });
        await c.get('info after restart with invalid options', taskPath(a, '/info'));
        await c.post('cancel before restart (json)', '/task/cancel', { json: { uuid: b } });
        await c.post('restart canceled task (urlencoded)', '/task/restart', { urlencoded: { uuid: b } });
        await c.waitFinal(b);
        await c.get('info after restarting a canceled task', taskPath(b, '/info'));

        await c.get('task list before remove', '/task/list');
        await c.post('remove (json)', '/task/remove', { json: { uuid: a } });
        await c.post('remove (urlencoded)', '/task/remove', { urlencoded: { uuid: b } });
        await c.get('info of removed task', taskPath(a, '/info'));
        await c.post('remove again', '/task/remove', { json: { uuid: a } });
        await c.get('task list after remove', '/task/list');
        await c.get('info at the end', '/info');
    }
});

scenarios.push({
    name: 'zip-input',
    needsUnzip: true,
    flags: () => [],
    run: async function (c) {
        const seed = buildZip([
            { name: 'images/seed_0001.JPG', data: seededBytes('seed1', 400) },
            { name: 'opensfm/note.txt', data: Buffer.from('seed note\n') }
        ]);
        const sd = await c.newTask('task new: seed.zip is extracted into the project', '/task/new', {
            fields: { name: 'seed zip' },
            files: c.images('d', 1).concat([{ field: 'images', name: 'seed.zip', data: seed }])
        });
        await c.waitFinal(sd);
        await c.get('info of task with seed.zip', taskPath(sd, '/info'));

        const ok = await c.newTask('task new: zipurl success', '/task/new', {
            fields: { name: 'zipurl ok', zipurl: c.zipUrl('/images.zip') }
        });
        await c.waitFinal(ok);
        await c.get('info of zipurl success', taskPath(ok, '/info'));
        await c.get('output of zipurl success', taskPath(ok, '/output'));

        const nf = await c.newTask('task new: zipurl 404', '/task/new', {
            fields: { name: 'zipurl 404', zipurl: c.zipUrl('/missing.zip') }
        });
        await c.waitFinal(nf);
        await c.get('info of zipurl 404', taskPath(nf, '/info'));
        await c.get('task list', '/task/list');
    }
});

// The server runs with a PATH that has neither unzip nor 7z, on every machine.
// A task with a zip file must fail with a clear error and the server must stay up.
scenarios.push({
    name: 'zip-input-no-tools',
    noTools: true,
    flags: () => [],
    run: async function (c) {
        const seed = buildZip([
            { name: 'images/seed_0001.JPG', data: seededBytes('seed1', 400) },
            { name: 'opensfm/note.txt', data: Buffer.from('seed note\n') }
        ]);
        await c.get('info at the start', '/info');

        const zu = await c.newTask('task new: zipurl without unzip or 7z', '/task/new', {
            fields: { name: 'zipurl no tools', zipurl: c.zipUrl('/images.zip') }
        });
        await c.waitFinal(zu);
        await c.get('info of zipurl without unzip or 7z', taskPath(zu, '/info'));

        const sd = await c.newTask('task new: seed.zip without unzip or 7z', '/task/new', {
            fields: { name: 'seed zip no tools' },
            files: c.images('n', 1).concat([{ field: 'images', name: 'seed.zip', data: seed }])
        });
        await c.waitFinal(sd);
        await c.get('info of task with seed.zip without unzip or 7z', taskPath(sd, '/info'));

        // The server must still answer
        await c.get('info at the end', '/info');
    }
});

scenarios.push({
    name: 'token',
    flags: () => ['--token', 'compat-secret'],
    run: async function (c) {
        await c.get('info without token', '/info');
        await c.get('info with wrong token', '/info?token=wrong');
        await c.get('info with token', '/info?token=compat-secret');
        await c.get('options without token', '/options');
        await c.get('auth info', '/auth/info');
        await c.get('static index page without token', '/');
        await c.get('task list without token', '/task/list');
        await c.post('task new without token', '/task/new', { fields: { name: 'no token' }, files: c.images('t', 1) });
        await c.post('task new init without token', '/task/new/init', { fields: { name: 'no token' } });
        await c.post('cancel without token', '/task/cancel', { urlencoded: { uuid: UNKNOWN_UUID } });
        const t = await c.newTask('task new with token', '/task/new?token=compat-secret', {
            fields: { name: 'with token', options: OPT_RES },
            files: c.images('t', 1)
        });
        c.token = 'compat-secret';
        await c.waitFinal(t);
        await c.get('task info without token', taskPath(t, '/info'));
        await c.get('task info with token', taskPath(t, '/info?token=compat-secret'));
        await c.get('download without token', taskPath(t, '/download/all.zip'));
        await c.get('download with token', taskPath(t, '/download/all.zip?token=compat-secret'));
        await c.get('task list with token', '/task/list?token=compat-secret');
        await c.post('cancel with token', '/task/cancel?token=compat-secret', { urlencoded: { uuid: t } });
        await c.post('remove with token', '/task/remove?token=compat-secret', { json: { uuid: t } });
        await c.get('task list after remove', '/task/list?token=compat-secret');
    }
});

scenarios.push({
    name: 'fail',
    flags: () => ['--test_fail_tasks'],
    run: async function (c) {
        const t = await c.newTask('task new', '/task/new', { fields: { name: 'failing task' }, files: c.images('f', 2) });
        await c.waitFinal(t);
        await c.get('info of failed task', taskPath(t, '/info'));
        await c.get('output of failed task', taskPath(t, '/output'));
        await c.get('download of failed task', taskPath(t, '/download/all.zip'));
        await c.post('restart failed task', '/task/restart', { json: { uuid: t } });
        await c.waitFinal(t);
        await c.get('info after restart', taskPath(t, '/info'));
        await c.get('task list', '/task/list');
    }
});

scenarios.push({
    name: 'limits',
    flags: () => ['--max_images', '1'],
    run: async function (c) {
        await c.get('info', '/info');
        const ok = await c.newTask('task new: one image', '/task/new', { fields: { name: 'one' }, files: c.images('l', 1) });
        await c.waitFinal(ok);
        await c.get('info of task with one image', taskPath(ok, '/info'));
        await c.post('task new: two images', '/task/new', { fields: { name: 'two' }, files: c.images('l', 2) });

        const init = await c.post('chunked: init', '/task/new/init', { fields: { name: 'two chunked' } });
        const ck = init.json && init.json.uuid;
        await c.post('chunked: upload 1', '/task/new/upload/' + ck, { files: c.images('m', 1) });
        await c.post('chunked: upload 2', '/task/new/upload/' + ck, { files: c.images('m2', 1) });
        const commit = await c.post('chunked: commit', '/task/new/commit/' + ck);
        await c.waitFinal(commit.json && commit.json.uuid);
        await c.get('chunked: info', taskPath(ck, '/info'));
        await c.get('task list', '/task/list');
    }
});

scenarios.push({
    name: 'skip-assets',
    flags: () => ['--test_skip_orthophotos', '--test_skip_dems'],
    run: async function (c) {
        const t = await c.newTask('task new', '/task/new', { fields: { name: 'skip assets' }, files: c.images('p', 2) });
        await c.waitFinal(t);
        await c.get('info', taskPath(t, '/info'));
        await c.get('output', taskPath(t, '/output'));
        await c.get('download all.zip', taskPath(t, '/download/all.zip'));
        await c.get('download orthophoto.tif (not a valid asset name)', taskPath(t, '/download/orthophoto.tif'));
    }
});

scenarios.push({
    name: 'webhook',
    flags: env => ['--webhook', 'http://127.0.0.1:' + env.hook.port + '/hook'],
    run: async function (c) {
        const hook = c.hook;

        // The recorded entry shows what the API sent to the hook and what the hook answered
        const recordCall = (name, call) => {
            return c.record(name, {
                method: call.method,
                path: call.path,
                headers: { 'content-type': call.contentType },
                body: { json: call.body }
            }, { status: call.status });
        };

        // First task: the hook answers 200
        hook.reset([200]);
        const t1 = await c.newTask('task new (hook answers 200)', '/task/new', { fields: { name: 'hook ok' }, files: c.images('w', 2) });
        await c.waitFinal(t1);
        await waitFor(() => hook.calls.length >= 1, HOOK_TIMEOUT, 100);
        await sleep(1500);
        c.record('hook calls for task 1', { note: 'number of POST requests received' }, { count: hook.calls.length });
        if (hook.calls[0]) recordCall('hook request 1 of task 1', hook.calls[0]);

        // Second task: the hook answers 500 first, then 200
        hook.reset([500, 200]);
        const t2 = await c.newTask('task new (hook answers 500, then 200)', '/task/new', { fields: { name: 'hook retry' }, files: c.images('w2', 1) });
        await c.waitFinal(t2);
        await waitFor(() => hook.calls.length >= 2, HOOK_TIMEOUT, 100);
        await sleep(1500);
        c.record('hook calls for task 2', { note: 'number of POST requests received within the wait' }, { count: hook.calls.length });
        hook.calls.forEach((call, i) => recordCall('hook request ' + (i + 1) + ' of task 2', call));
        await c.get('task list', '/task/list');
    }
});

// ---------------------------------------------------------------------------
// Running

function parseArgs(argv) {
    const sep = argv.indexOf('--');
    const own = sep === -1 ? argv : argv.slice(0, sep);
    const command = sep === -1 ? [] : argv.slice(sep + 1);
    const opts = { app: null, update: false, only: null, keep: false, command };
    for (let i = 0; i < own.length; i++) {
        const a = own[i];
        if (a === '--app') opts.app = own[++i];
        else if (a === '--update') opts.update = true;
        else if (a === '--only') opts.only = own[++i];
        else if (a === '--keep') opts.keep = true;
        else throw new Error('Unknown argument: ' + a);
    }
    return opts;
}

function usage() {
    return 'Usage: node tests/compat/run.js --app <dir> [--update] [--only <scenario>] [--keep] -- <command> [args...]';
}

function stepText(entry) {
    return JSON.stringify(entry, null, 2);
}

function hasZipBody(entry) {
    return !!(entry && entry.response && entry.response.body && entry.response.body.zip);
}

// When skipZip is set, steps that return a zip listing are not compared.
// Returns {problems, skipped}
function compare(actual, expected, skipZip) {
    const problems = [];
    let skipped = 0;
    const max = Math.max(actual.length, expected.length);
    for (let i = 0; i < max; i++) {
        const a = actual[i];
        const e = expected[i];
        if (skipZip && a && e && (hasZipBody(a) || hasZipBody(e))) {
            skipped++;
        } else if (!a) {
            problems.push('Step ' + (i + 1) + ' "' + e.step + '" is in the golden file but was not run.');
        } else if (!e) {
            problems.push('Step ' + (i + 1) + ' "' + a.step + '" was run but is not in the golden file.');
        } else if (stepText(a) !== stepText(e)) {
            const label = a.step === e.step ? a.step : e.step + ' / ' + a.step;
            problems.push('Step ' + (i + 1) + ' "' + label + '" differs:\n' + diffText(stepText(e), stepText(a)));
        }
    }
    return { problems, skipped };
}

async function runScenario(sc, opts, env) {
    const result = { name: sc.name, steps: 0, problems: [], error: null, log: [] };
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-compat-' + sc.name + '-'));
    let server = null;
    try {
        copyApp(opts.appDir, copyDir);
        if (sc.noTools) removeBundledTools(copyDir);
        const port = await freePort();
        server = startServer(opts.command, copyDir, port, sc.flags(env), !!sc.noTools);
        await waitReady(server, port);
        const ctx = makeContext(env, port);
        await sc.run(ctx);
        result.steps = ctx.entries.length;

        if (opts.update) {
            fs.mkdirSync(GOLDEN_DIR, { recursive: true });
            fs.writeFileSync(path.join(GOLDEN_DIR, sc.name + '.json'), JSON.stringify(ctx.entries, null, 2) + '\n');
        } else {
            const file = path.join(GOLDEN_DIR, sc.name + '.json');
            if (!fs.existsSync(file)) {
                result.problems.push('Golden file is missing: ' + file + ' (run with --update to create it)');
            } else {
                const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
                const cmp = compare(JSON.parse(JSON.stringify(ctx.entries)), expected, !env.tools.sevenZ);
                result.problems = cmp.problems;
                result.skippedSteps = cmp.skipped;
            }
        }
    } catch (e) {
        result.error = e && e.stack ? e.stack : String(e);
    } finally {
        if (server) {
            result.log = server.lines.slice(-50);
            await stopServer(server);
        }
        if (!opts.keep) rmrf(copyDir);
        else console.log('Kept ' + copyDir);
    }
    return result;
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
        if (!opts.app || opts.command.length === 0) throw new Error('Missing --app or command.');
    } catch (e) {
        console.error(e.message);
        console.error(usage());
        process.exit(2);
    }
    opts.appDir = path.resolve(opts.app);
    if (!fs.existsSync(opts.appDir)) {
        console.error('App directory does not exist: ' + opts.appDir);
        process.exit(2);
    }

    const list = opts.only ? scenarios.filter(s => s.name === opts.only) : scenarios;
    if (list.length === 0) {
        console.error('Unknown scenario: ' + opts.only + '. Known: ' + scenarios.map(s => s.name).join(', '));
        process.exit(2);
    }

    const tools = { unzip: hasTool('unzip', opts.appDir), sevenZ: hasTool('7z', opts.appDir) };
    console.log('Tools: unzip ' + (tools.unzip ? 'found' : 'missing') + ', 7z ' + (tools.sevenZ ? 'found' : 'missing'));
    const canUnzip = tools.unzip || tools.sevenZ;
    // Scenarios that start the server without the tools do not need them on PATH
    if (opts.update && !(tools.unzip && tools.sevenZ) && list.some(s => !s.noTools)) {
        console.error('Golden files must be recorded with both unzip and 7z on PATH.');
        process.exit(2);
    }

    // Test zip files served to the zipurl cases
    const zipFiles = {
        '/images.zip': buildZip([
            { name: 'zip_0001.JPG', data: seededBytes('zip1', 350) },
            { name: 'sub/zip_0002.JPG', data: seededBytes('zip2', 351) },
            { name: 'zip_0003.JPG', data: seededBytes('zip3', 352) }
        ])
    };
    const zipSrv = await startZipServer(zipFiles);
    const hook = await startHookServer();
    const env = { zipPort: zipSrv.port, hook, tools };

    let failed = 0;
    const skipped = [];
    const started = Date.now();

    for (const sc of list) {
        if (sc.needsUnzip && !canUnzip) {
            const reason = 'neither unzip nor 7z is on PATH (the golden file holds the messages of the tools; zip-input-no-tools checks the case without them)';
            console.log('SKIP ' + sc.name + ': ' + reason);
            skipped.push(sc.name + ' (' + reason + ')');
            continue;
        }
        const t0 = Date.now();
        const r = await runScenario(sc, opts, env);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.error || r.problems.length) {
            failed++;
            console.log('FAIL ' + sc.name + ' (' + secs + ' s)');
            if (r.error) console.log(r.error);
            r.problems.forEach(p => console.log('\n' + p));
            console.log('\nLast ' + r.log.length + ' lines of server output:');
            r.log.forEach(l => console.log('  | ' + l));
            console.log('');
        } else {
            console.log((opts.update ? 'WROTE ' : 'PASS  ') + sc.name + ' (' + r.steps + ' steps, ' + secs + ' s)');
            if (r.skippedSteps) {
                skipped.push(sc.name + ': ' + r.skippedSteps + ' zip listing step(s) not compared (7z is missing, so the JavaScript fallback built all.zip and lists directories differently)');
            }
        }
    }

    zipSrv.server.close();
    hook.server.close();

    if (skipped.length) console.log('Skipped: ' + skipped.join('; '));
    console.log(failed ? failed + ' scenario(s) failed.' : 'All scenarios passed.' );
    console.log('Total time ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
    process.exit(failed ? 1 : 0);
}

main().catch(e => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
});
