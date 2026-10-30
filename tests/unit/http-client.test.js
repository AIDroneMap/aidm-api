const { test, expect, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { createRequire } = require('module');

const root = path.join(__dirname, '../..');
const servers = [];
const folders = [];

afterEach(() => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        server.close();
    }
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function loadModule(relativePath, overrides = {}, globals = {}, suffix = '') {
    const filename = path.join(root, relativePath);
    const localRequire = createRequire(filename);
    const loaded = { exports: {} };
    const context = {
        require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
        module: loaded,
        exports: loaded.exports,
        Buffer,
        setTimeout,
        ...globals
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + suffix, context, { filename });
    return loaded.exports;
}

function loadDownload(overrides = {}) {
    return loadModule('libs/taskNew.js', Object.defineProperties({
        './storage': { files: () => () => {} },
        './TaskManager': {},
        './Task': {},
        './odmInfo': {},
        './logger': {},
        './Directories': {},
        '../config.js': {}
    }, Object.getOwnPropertyDescriptors(overrides)), {}, '\nmodule.exports.testDownload = download;').testDownload;
}

async function serve(handler) {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}

function destination() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-http-'));
    folders.push(folder);
    return path.join(folder, 'archive.zip');
}

function transfer(download, uri, filename) {
    return new Promise(resolve => {
        const results = [];
        download(uri, filename, error => {
            results.push(error);
            setTimeout(() => resolve(results), 25);
        });
    });
}

test('removes request from the manifest, lockfile and runtime imports', () => {
    expect(require('../../package.json').dependencies).not.toHaveProperty('request');
    expect(fs.readFileSync(path.join(root, 'bun.lock'), 'utf8')).not.toMatch(/"request"\s*:/);
    expect(fs.readFileSync(path.join(root, 'libs/Task.js'), 'utf8')).not.toMatch(/require\(['"]request['"]\)/);
});

test('loads both runtime callers without request', () => {
    const overrides = {};
    Object.defineProperty(overrides, 'request', {
        enumerable: true,
        get() { throw new Error('Deprecated request loaded at runtime'); }
    });
    expect(() => loadDownload(overrides)).not.toThrow();
    expect(() => loadModule('libs/Task.js', Object.defineProperties({
        '../config': {},
        './logger': {},
        './odmRunner': {},
        './odmInfo': {},
        './processRunner': {},
        './S3': {}
    }, Object.getOwnPropertyDescriptors(overrides)))).not.toThrow();
});

test.each([301, 302, 303, 307, 308])('downloads HEAD then GET through %s redirects with URL credentials', async status => {
    const calls = [];
    const address = await serve((request, response) => {
        calls.push([request.method, request.url, request.headers.authorization, request.headers.referer]);
        if (request.url === '/start') response.writeHead(status, { location: '/archive' });
        response.end('archive bytes');
    });
    const authenticated = address.replace('http://', 'http://user:p%40ss@');
    const filename = destination();
    expect(await transfer(loadDownload(), `${authenticated}/start`, filename)).toEqual([undefined]);
    const authorization = `Basic ${Buffer.from('user:p@ss').toString('base64')}`;
    expect(calls).toEqual([
        ['HEAD', '/start', authorization, undefined],
        ['HEAD', '/archive', authorization, `${authenticated}/start`],
        ['GET', '/start', authorization, undefined],
        ['GET', '/archive', authorization, `${authenticated}/start`]
    ]);
    expect(fs.readFileSync(filename, 'utf8')).toBe('archive bytes');
});

test('selects the HTTPS transport for both methods across a protocol redirect', async () => {
    const calls = [];
    const address = await serve((request, response) => {
        if (request.url === '/start') {
            response.writeHead(302, { location: address.replace('http:', 'https:') + '/archive' });
        }
        response.end('archive bytes');
    });
    const client = loadModule('libs/httpClient.js', {
        https: {
            request: (options, callback) => {
                calls.push([options.protocol, options.method]);
                return http.request({ ...options, protocol: 'http:' }, callback);
            }
        }
    });
    const filename = destination();
    expect(await transfer(loadDownload({ './httpClient': client }), `${address}/start`, filename)).toEqual([undefined]);
    expect(calls).toEqual([['https:', 'HEAD'], ['https:', 'GET']]);
    expect(fs.readFileSync(filename, 'utf8')).toBe('archive bytes');
});

test('drops authorization on a redirect to another hostname', async () => {
    const calls = [];
    const address = await serve((request, response) => {
        calls.push([request.url, request.headers.authorization]);
        if (request.url === '/start') {
            response.writeHead(302, { location: address.replace('127.0.0.1', 'localhost') + '/archive' });
        }
        response.end('archive bytes');
    });
    const filename = destination();
    const authenticated = address.replace('http://', 'http://user:pass@');
    expect(await transfer(loadDownload(), `${authenticated}/start`, filename)).toEqual([undefined]);
    const authorization = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    expect(calls).toEqual([
        ['/start', authorization], ['/archive', undefined],
        ['/start', authorization], ['/archive', undefined]
    ]);
});

test('keeps HTTP error response bodies available for ZIP validation', async () => {
    const calls = [];
    const address = await serve((request, response) => {
        calls.push(request.method);
        response.writeHead(404);
        response.end('not a ZIP');
    });
    const filename = destination();
    expect(await transfer(loadDownload(), address, filename)).toEqual([undefined]);
    expect(calls).toEqual(['HEAD', 'GET']);
    expect(fs.readFileSync(filename, 'utf8')).toBe('not a ZIP');
});

test.each([
    ['not-a-url', 'Invalid URI "not-a-url"'],
    ['http://127.0.0.1:1', 'connect ECONNREFUSED 127.0.0.1:1'],
    ['ftp://example.com/archive.zip', 'Invalid protocol: ftp:']
])('keeps the download error for %s', async (uri, message) => {
    const filename = destination();
    const results = await transfer(loadDownload(), uri, filename);
    expect(results).toHaveLength(1);
    expect(results[0].message).toBe(message);
    expect(fs.existsSync(filename)).toBe(false);
});

test('stops redirect loops after ten hops with the existing error', async () => {
    const calls = [];
    const address = await serve((request, response) => {
        calls.push(request.method);
        response.writeHead(302, { location: '/loop' });
        response.end();
    });
    const results = await transfer(loadDownload(), `${address}/loop`, destination());
    expect(results).toHaveLength(1);
    expect(results[0].message).toBe(`Exceeded maxRedirects. Probably stuck in a redirect loop ${address}/loop`);
    expect(calls).toEqual(Array(11).fill('HEAD'));
});

test('reports a GET connection failure once after a successful HEAD', async () => {
    const address = await serve((request, response) => {
        if (request.method === 'HEAD') response.end();
        else request.socket.destroy();
    });
    const results = await transfer(loadDownload(), address, destination());
    expect(results).toHaveLength(1);
    expect(results[0]).toBeTruthy();
}, 1500);

test('reports an interrupted download once instead of accepting partial bytes', async () => {
    const address = await serve((request, response) => {
        response.writeHead(200, { 'content-length': '1000' });
        if (request.method === 'HEAD') response.end();
        else {
            response.write('partial');
            setTimeout(() => response.destroy(), 10);
        }
    });
    const results = await transfer(loadDownload(), address, destination());
    expect(results).toHaveLength(1);
    expect(results[0]).toBeTruthy();
}, 1500);

test('reports a destination stream failure once', async () => {
    const address = await serve((request, response) => response.end('archive'));
    const filename = path.join(destination(), 'missing', 'archive.zip');
    const results = await transfer(loadDownload(), address, filename);
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe('ENOENT');
}, 1500);

async function notify(hook, globalHook = null) {
    const delays = [];
    const warnings = [];
    const payload = { uuid: 'test-task', status: { code: 40 } };
    const images = [{ filename: 'image.jpg' }];
    await new Promise(resolve => {
        const Task = loadModule('libs/Task.js', {
            '../config': { webhook: globalHook },
            './odmRunner': {},
            './odmInfo': {},
            './processRunner': {},
            './S3': {},
            './logger': {
                warn: message => {
                    warnings.push(message);
                    if (String(message).includes('will not retry')) resolve();
                },
                debug: () => resolve()
            }
        }, {
            setTimeout: (callback, delay) => {
                delays.push(delay);
                return setTimeout(callback, 0);
            }
        });
        Task.prototype.callWebhooks.call({
            webhook: hook,
            getInfo: () => ({ ...payload }),
            readImagesDatabase: callback => callback(null, images)
        });
    });
    return { delays, warnings, payload: { ...payload, images } };
}

test('posts webhook JSON and headers, retrying non-200 responses until 200', async () => {
    const calls = [];
    const address = await serve((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            calls.push({ method: request.method, body, headers: request.headers });
            response.writeHead(calls.length < 3 ? [503, 201][calls.length - 1] : 200);
            response.end('ok');
        });
    });
    const result = await notify(address.replace('http://', 'http://user:pass@'));
    expect(result.delays).toEqual([0, 5000]);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
        expect(call.method).toBe('POST');
        expect(JSON.parse(call.body)).toEqual(result.payload);
        expect(call.headers.accept).toBe('application/json');
        expect(call.headers['content-type']).toBe('application/json');
        expect(Number(call.headers['content-length'])).toBe(Buffer.byteLength(call.body));
        expect(call.headers.authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
    }
});

test.each([302, 307, 308])('does not follow webhook %s redirects and stops after six attempts', async status => {
    const calls = [];
    const address = await serve((request, response) => {
        calls.push(request.url);
        response.writeHead(status, { location: '/must-not-follow' });
        response.end();
    });
    const result = await notify(null, `${address}/hook`);
    expect(calls).toEqual(Array(6).fill('/hook'));
    expect(result.delays).toEqual([0, 5000, 10000, 15000, 20000, 25000]);
    expect(result.warnings).toHaveLength(7);
});

test.each(['not-a-url', 'http://127.0.0.1:1'])('retries webhook network or URL errors for %s', async uri => {
    const result = await notify(uri);
    expect(result.delays).toEqual([0, 5000, 10000, 15000, 20000, 25000]);
    expect(result.warnings).toHaveLength(7);
});

test('retries an interrupted webhook response', async () => {
    let attempts = 0;
    const address = await serve((request, response) => {
        attempts++;
        if (attempts === 1) {
            response.writeHead(200, { 'content-length': '1000' });
            response.write('partial');
            setTimeout(() => response.destroy(), 10);
        } else response.end('ok');
    });
    const result = await notify(address);
    expect(attempts).toBe(2);
    expect(result.delays).toEqual([0]);
});
