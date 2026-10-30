const { test, expect, beforeEach, afterEach, spyOn } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const http = require('http');
const storage = require('../../libs/storage');

const boundary = 'storage-test-boundary';
let root;
let uploads;
let restores;
let sequence = 0;

const deferred = () => {
    let resolve;
    const promise = new Promise(done => resolve = done);
    return { promise, resolve };
};

const turn = () => new Promise(resolve => setImmediate(resolve));

const part = (name, value, filename) => {
    const file = filename === undefined ? '' : `; filename="${filename}"`;
    const type = filename === undefined ? '' : '\r\nContent-Type: application/octet-stream';
    return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file}${type}\r\n\r\n${value}\r\n`;
};

const form = (...parts) => parts.join('') + `--${boundary}--\r\n`;

function start({ fields = false, id = ++sequence, contentType = `multipart/form-data; boundary=${boundary}`, rename = name => name === 'body.json' ? '_body.json' : name } = {}) {
    const req = new PassThrough();
    req.headers = { 'content-type': contentType };
    req.id = id;
    req.complete = false;
    req.socket = new EventEmitter();
    req.socket.destroyed = false;
    req.timeouts = [];
    req.setTimeout = (duration, callback) => {
        req.timeouts.push(duration);
        if (callback) req.on('timeout', callback);
    };
    req.on('end', () => req.complete = true);
    req.on('error', () => {});
    const result = deferred();
    const calls = [];
    const middleware = fields ? storage.fields() : storage.files('images', () => path.join(root, 'uploads'), rename, 60000);
    middleware(req, {}, err => {
        calls.push(err);
        result.resolve(err);
    });
    const upload = { req, result: result.promise, calls };
    uploads.push(upload);
    return upload;
}

function delayClose() {
    const created = deferred();
    const closed = deferred();
    const original = fs.createWriteStream;
    let pending;
    let released = false;
    const release = () => {
        released = true;
        if (pending) {
            const close = pending;
            pending = null;
            close();
        }
    };
    const spy = spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
        const out = original(...args);
        const emit = out.emit;
        out.emit = function (event, ...values) {
            if (event !== 'close' || released) return emit.call(this, event, ...values);
            pending = () => emit.call(this, event, ...values);
            closed.resolve();
            return true;
        };
        created.resolve(out);
        return out;
    });
    restores.push(() => {
        release();
        spy.mockRestore();
    });
    return { created: created.promise, closed: closed.promise, release };
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-storage-'));
    uploads = [];
    restores = [];
});

afterEach(async () => {
    restores.forEach(restore => restore());
    await Promise.all(uploads.map(({ req }) => new Promise(resolve => {
        req.destroy();
        storage.cancel(req.id, resolve);
    })));
    fs.rmSync(root, { recursive: true, force: true });
});

test('pins the current busboy API without a constructor', () => {
    expect(require('../../package.json').dependencies.busboy).toBe('1.6.0');
    expect(require('busboy/package.json').version).toBe('1.6.0');
    expect(() => new (require('busboy'))({ headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })).toThrow();
});

test('preserves fields, repeated values, UTF-8 filenames, empty files and file counts', async () => {
    const { req, result, calls } = start();
    req.end(form(
        part('name', 'survey'), part('options', 'first'), part('options', 'second'),
        part('__proto__', 'data'), part('images', 'photo', 'café.jpg'),
        part('images', '', 'empty.jpg'), part('images', 'metadata', 'body.json')
    ));
    expect(await result).toBeUndefined();
    expect(Object.getPrototypeOf(req.body)).toBeNull();
    expect({ ...req.body }).toEqual({ name: 'survey', options: ['first', 'second'], ['__proto__']: 'data' });
    expect(req.files.map(filename => path.basename(filename)).sort()).toEqual(['_body.json', 'café.jpg', 'empty.jpg']);
    expect(fs.readFileSync(path.join(root, 'uploads', 'café.jpg'), 'utf8')).toBe('photo');
    expect(fs.readFileSync(path.join(root, 'uploads', 'empty.jpg'))).toHaveLength(0);
    expect(fs.readFileSync(path.join(root, 'uploads', '_body.json'), 'utf8')).toBe('metadata');
    expect(calls).toHaveLength(1);
    expect(req.timeouts).toEqual([60000, 0]);
    expect(req.socket.listenerCount('close')).toBe(0);
});

test('parses fields without creating a files list', async () => {
    const { req, result } = start({ fields: true });
    req.end(form(part('name', 'survey'), part('name', 'second')));
    expect(await result).toBeUndefined();
    expect(req.body.name).toEqual(['survey', 'second']);
    expect(req.files).toBeUndefined();
    expect(req.timeouts).toEqual([]);
});

test('skips non-multipart requests', async () => {
    const { req, result } = start({ contentType: 'application/json' });
    expect(await result).toBeUndefined();
    expect(req.body).toBeUndefined();
    expect(req.files).toBeUndefined();
});

test('does not overwrite existing files or duplicate filenames', async () => {
    fs.mkdirSync(path.join(root, 'uploads'));
    fs.writeFileSync(path.join(root, 'uploads', 'photo.jpg'), 'original');
    const { req, result } = start();
    req.end(form(part('images', 'one', 'photo.jpg'), part('images', 'two', 'photo.jpg')));
    expect(await result).toBeUndefined();
    expect(req.files.map(filename => path.basename(filename)).sort()).toEqual(['photo_.jpg', 'photo__.jpg']);
    expect(fs.readFileSync(path.join(root, 'uploads', 'photo.jpg'), 'utf8')).toBe('original');
    expect(req.files.map(filename => fs.readFileSync(filename, 'utf8')).sort()).toEqual(['one', 'two']);
});

test('does not follow a destination symlink outside the upload directory', async () => {
    fs.mkdirSync(path.join(root, 'uploads'));
    const target = path.join(root, 'target.jpg');
    fs.writeFileSync(target, 'original');
    fs.symlinkSync(target, path.join(root, 'uploads', 'photo.jpg'));
    const { req, result } = start();
    req.end(form(part('images', 'data', 'photo.jpg')));
    expect(await result).toBeUndefined();
    expect(req.files.map(filename => path.basename(filename))).toEqual(['photo_.jpg']);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    expect(fs.readFileSync(req.files[0], 'utf8')).toBe('data');
});

test('strips uploaded POSIX and Windows paths and decodes extended filenames', async () => {
    const { req, result } = start();
    req.end(form(
        part('images', 'one', '../../outside.jpg'),
        part('images', 'two', 'C:\\fakepath\\windows.jpg'),
        part('images', 'three', 'ignored.jpg').replace('filename="ignored.jpg"', "filename*=UTF-8''caf%C3%A9.jpg")
    ));
    expect(await result).toBeUndefined();
    expect(req.files.map(filename => path.basename(filename)).sort()).toEqual(['café.jpg', 'outside.jpg', 'windows.jpg']);
    expect(fs.readdirSync(root)).toEqual(['uploads']);
});

test.each(['../escaped.jpg', '/escaped.jpg', '..\\escaped.jpg', '.', '..'])('rejects unsafe renamed filename %s', async filename => {
    const { req, result } = start({ rename: () => filename });
    req.end(form(part('images', 'data', 'photo.jpg')));
    expect((await result).message).toBe('Invalid filename');
    expect(req.files).toEqual([]);
    expect(fs.existsSync(path.join(root, 'escaped.jpg'))).toBe(false);
});

test('ignores an empty filename without counting a file', async () => {
    const { req, result } = start();
    req.end(form(part('images', '', '')));
    expect(await result).toBeUndefined();
    expect(req.files).toEqual([]);
});

test('rejects unexpected file fields and removes files from the same request', async () => {
    const { req, result, calls } = start();
    req.end(form(part('images', 'good', 'good.jpg'), part('other', 'bad', 'bad.jpg')));
    expect((await result).message).toBe('Unexpected field');
    expect(fs.readdirSync(path.join(root, 'uploads'))).toEqual([]);
    expect(calls).toHaveLength(1);
});

test('handles errors on a discarded file stream without a second callback', async () => {
    const { req, result, calls } = start();
    req.end(part('other', 'unfinished', 'photo.jpg'));
    expect((await result).message).toBe('Unexpected field');
    await turn();
    expect(calls).toHaveLength(1);
    expect(req.files).toEqual([]);
});

test('rejects field values above the existing 1 MiB limit', async () => {
    const { req, result } = start({ fields: true });
    req.end(form(part('options', 'a'.repeat(1024 * 1024 + 1))));
    expect((await result).message).toBe('Field value too long: options');
});

test('accepts field values exactly at the existing 1 MiB limit', async () => {
    const { req, result } = start({ fields: true });
    const value = 'a'.repeat(1024 * 1024);
    req.end(form(part('options', value)));
    expect(await result).toBeUndefined();
    expect(req.body.options).toBe(value);
});

test('rejects files in fields-only requests', async () => {
    const { req, result } = start({ fields: true });
    req.end(form(part('images', 'data', 'photo.jpg')));
    expect((await result).message).toBe('Unexpected field');
    expect(req.files).toBeUndefined();
});

test('rejects missing multipart boundaries with the existing message', async () => {
    const { result, calls } = start({ contentType: 'multipart/form-data' });
    expect((await result).message).toBe('Multipart: Boundary not found');
    expect(calls).toHaveLength(1);
});

test('rejects malformed boundary parameters', async () => {
    const { result, calls } = start({ contentType: 'multipart/form-data; boundary="unterminated' });
    expect(await result).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
});

test.each(['not-a-boundary', part('name', 'unfinished'), part('images', 'unfinished', 'photo.jpg')])('rejects truncated multipart input %# and cleans up', async body => {
    const { req, result, calls } = start();
    req.end(body);
    expect((await result).message).toBe('Unexpected end of multipart data');
    expect(fs.existsSync(path.join(root, 'uploads')) ? fs.readdirSync(path.join(root, 'uploads')) : []).toEqual([]);
    await turn();
    expect(calls).toHaveLength(1);
});

test('rejects malformed part headers without leaking a partial file', async () => {
    const { req, result } = start();
    req.end(form(`--${boundary}\r\ninvalid header\r\n\r\ndata\r\n`));
    expect(await result).toBeInstanceOf(Error);
    expect(req.files).toEqual([]);
});

test('waits for the destination close before completing a successful upload', async () => {
    const delayed = delayClose();
    const { req, result, calls } = start();
    req.end(form(part('images', 'data', 'photo.jpg')));
    await delayed.closed;
    expect(calls).toHaveLength(0);
    delayed.release();
    expect(await result).toBeUndefined();
    expect(calls).toHaveLength(1);
});

test('reports a destination error once and removes partial files', async () => {
    const delayed = delayClose();
    const { req, result, calls } = start();
    req.write(part('images', 'partial', 'photo.jpg').slice(0, -2));
    const out = await delayed.created;
    out.destroy(new Error('write failed'));
    req.end(`\r\n--${boundary}--\r\n`);
    await delayed.closed;
    expect(calls).toHaveLength(0);
    delayed.release();
    expect((await result).message).toBe('write failed');
    expect(fs.readdirSync(path.join(root, 'uploads'))).toEqual([]);
    expect(calls).toHaveLength(1);
});

test('drains a large file when its destination cannot be created', async () => {
    fs.writeFileSync(path.join(root, 'uploads'), 'not a directory');
    const { req, result, calls } = start();
    req.write(part('images', '', 'photo.jpg').slice(0, -2));
    req.write('a'.repeat(128 * 1024));
    req.end(`\r\n--${boundary}--\r\n`);
    expect((await result).code).toBe('EEXIST');
    expect(calls).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'uploads'), 'utf8')).toBe('not a directory');
});

test('cancellation waits for a pending file open and removes the partial file', async () => {
    const opened = deferred();
    const original = fs.open;
    let pending;
    const release = () => {
        if (!pending) return;
        const complete = pending;
        pending = null;
        complete();
    };
    const spy = spyOn(fs, 'open').mockImplementation((filename, flags, callback) => {
        original(filename, flags, (err, descriptor) => {
            pending = () => callback(err, descriptor);
            opened.resolve();
        });
    });
    restores.push(() => {
        release();
        spy.mockRestore();
    });
    const { req, result, calls } = start();
    req.write(part('images', 'partial', 'photo.jpg').slice(0, -2));
    await opened.promise;
    const callbacks = [];
    const cleanup = new Promise(resolve => storage.cancel(req.id, () => { callbacks.push(true); resolve(); }));
    expect((await result).message).toBe('Upload canceled');
    expect(callbacks).toHaveLength(0);
    release();
    await cleanup;
    expect(fs.readdirSync(path.join(root, 'uploads'))).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(callbacks).toHaveLength(1);
});

test('cancellation waits for a finished file to close before deleting it', async () => {
    const delayed = delayClose();
    const { req, result, calls } = start();
    req.end(form(part('images', 'complete', 'photo.jpg')));
    await delayed.closed;
    expect(req.files).toHaveLength(1);
    const callbacks = [];
    const cleanup = new Promise(resolve => storage.cancel(req.id, () => { callbacks.push(true); resolve(); }));
    expect((await result).message).toBe('Upload canceled');
    expect(callbacks).toHaveLength(0);
    expect(fs.existsSync(req.files[0])).toBe(true);
    delayed.release();
    await cleanup;
    expect(fs.readdirSync(path.join(root, 'uploads'))).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(callbacks).toHaveLength(1);
});

test('aborts a rejected upload while its remaining request body is still pending', async () => {
    const { req, result, calls } = start();
    req.write(part('other', 'partial', 'photo.jpg').slice(0, -2));
    await turn();
    expect(calls).toHaveLength(0);
    req.emit('aborted');
    expect((await result).message).toBe('Upload aborted');
    req.emit('error', new Error('connection reset'));
    req.socket.emit('close');
    await turn();
    expect(calls).toHaveLength(1);
    expect(req.files).toEqual([]);
});

test('cancellation after success or for an unknown id calls back once without deleting files', async () => {
    const { req, result, calls } = start();
    req.end(form(part('images', 'data', 'photo.jpg')));
    expect(await result).toBeUndefined();
    const canceled = [];
    storage.cancel(req.id, () => canceled.push('complete'));
    storage.cancel('unknown', () => canceled.push('unknown'));
    expect(canceled).toEqual(['complete', 'unknown']);
    expect(fs.readFileSync(req.files[0], 'utf8')).toBe('data');
    expect(calls).toHaveLength(1);
});

test.each(['aborted', 'error', 'socket', 'timeout'])('aborts on %s and waits for close before cancellation cleanup', async reason => {
    const delayed = delayClose();
    const { req, result, calls } = start();
    req.write(part('images', 'partial', 'photo.jpg').slice(0, -2));
    await delayed.created;
    if (reason === 'socket') req.socket.emit('close');
    else if (reason === 'error') req.emit('error', new Error('request failed'));
    else req.emit(reason);
    expect((await result).message).toBe(reason === 'timeout' ? 'Upload timed out' : 'Upload aborted');
    const canceled = [];
    const cleanup = new Promise(resolve => storage.cancel(req.id, () => { canceled.push(true); resolve(); }));
    await delayed.closed;
    expect(canceled).toHaveLength(0);
    delayed.release();
    await cleanup;
    expect(fs.readdirSync(path.join(root, 'uploads'))).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(canceled).toHaveLength(1);
    expect(req.timeouts.at(-1)).toBe(0);
    expect(req.socket.listenerCount('close')).toBe(0);
});

test('cancels all uploads for an id and calls each waiter once after close', async () => {
    const delayed = delayClose();
    const first = start();
    first.req.write(part('images', 'partial', 'first.jpg').slice(0, -2));
    await delayed.created;
    const second = start({ id: first.req.id });
    const third = start({ id: first.req.id });
    const callbacks = [];
    const cancel = () => new Promise(resolve => storage.cancel(first.req.id, () => { callbacks.push(true); resolve(); }));
    const firstCancel = cancel();
    const secondCancel = cancel();
    expect((await first.result).message).toBe('Upload canceled');
    expect((await second.result).message).toBe('Upload canceled');
    expect((await third.result).message).toBe('Upload canceled');
    await delayed.closed;
    expect(callbacks).toHaveLength(0);
    delayed.release();
    await Promise.all([firstCancel, secondCancel]);
    expect(callbacks).toHaveLength(2);
    expect(fs.readdirSync(path.join(root, 'uploads'))).toEqual([]);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(third.calls).toHaveLength(1);
    await cancel();
    expect(callbacks).toHaveLength(3);
});

test('cleans up a disconnected HTTP upload after its destination closes', async () => {
    const delayed = delayClose();
    const received = deferred();
    const calls = [];
    const id = ++sequence;
    const server = http.createServer((req, res) => {
        req.id = id;
        storage.files('images', () => path.join(root, 'uploads'), name => name, 60000)(req, res, err => {
            calls.push(err);
            received.resolve(err);
            res.destroy();
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = http.request({
        host: '127.0.0.1', port: server.address().port, method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
    });
    client.on('error', () => {});
    try {
        client.write(part('images', 'partial', 'photo.jpg').slice(0, -2));
        await delayed.created;
        client.destroy();
        expect((await received.promise).message).toBe('Upload aborted');
        const callbacks = [];
        const cleanup = new Promise(resolve => storage.cancel(id, () => { callbacks.push(true); resolve(); }));
        await delayed.closed;
        expect(callbacks).toHaveLength(0);
        delayed.release();
        await cleanup;
        expect(fs.readdirSync(path.join(root, 'uploads'))).toEqual([]);
        expect(callbacks).toHaveLength(1);
        expect(calls).toHaveLength(1);
    } finally {
        client.destroy();
        delayed.release();
        await new Promise(resolve => storage.cancel(id, resolve));
        await new Promise(resolve => server.close(resolve));
    }
});
