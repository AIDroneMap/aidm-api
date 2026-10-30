const { test, expect, beforeEach, afterEach, spyOn } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const move = require('../../libs/move');

let root;
let source;
let destination;
let spies;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-move-'));
    source = path.join(root, 'source');
    destination = path.join(root, 'destination');
    spies = [];
});

afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
});

function replace(method, implementation) {
    const spy = spyOn(fs, method).mockImplementation(implementation);
    spies.push(spy);
    return spy;
}

function acrossDevices() {
    return replace('rename', (source, destination, callback) => {
        queueMicrotask(() => callback(Object.assign(new Error('Cross-device move'), { code: 'EXDEV' })));
    });
}

function uploadDirectory(directory) {
    fs.mkdirSync(path.join(directory, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'nested', 'image.jpg'), 'image');
    fs.symlinkSync('nested/image.jpg', path.join(directory, 'image-link'));
}

async function result() {
    const calls = [];
    await new Promise(resolve => {
        move(source, destination, err => {
            calls.push(err);
            resolve();
        });
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toHaveLength(1);
    return calls[0];
}

function expectDirectoryMoved() {
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'nested', 'image.jpg'), 'utf8')).toBe('image');
    expect(fs.readlinkSync(path.join(destination, 'image-link'))).toBe('nested/image.jpg');
}

test('uploads have no direct mv dependency', () => {
    const manifest = require('../../package.json');
    const source = fs.readFileSync(path.join(__dirname, '../../libs/taskNew.js'), 'utf8');

    expect(manifest.dependencies).not.toHaveProperty('mv');
    expect(source).not.toMatch(/require\(['"]mv['"]\)/);
});

test.each(['rename', 'EXDEV'])('%s moves a file to its exact destination', async method => {
    if (method === 'EXDEV') acrossDevices();
    fs.writeFileSync(source, 'seed or GCP file');

    expect(await result()).toBeFalsy();
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(destination, 'utf8')).toBe('seed or GCP file');
});

test.each(['rename', 'EXDEV'])('%s overwrites an existing file', async method => {
    if (method === 'EXDEV') acrossDevices();
    fs.writeFileSync(source, 'new');
    fs.writeFileSync(destination, 'old contents are longer');

    expect(await result()).toBeFalsy();
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(destination, 'utf8')).toBe('new');
});

test.each(['rename', 'EXDEV'])('%s moves an upload directory without nesting it', async method => {
    if (method === 'EXDEV') acrossDevices();
    uploadDirectory(source);

    expect(await result()).toBeFalsy();
    expectDirectoryMoved();
});

test('rename replaces an empty destination directory', async () => {
    uploadDirectory(source);
    fs.mkdirSync(destination);

    expect(await result()).toBeFalsy();
    expectDirectoryMoved();
});

test('rename rejects a nonempty destination directory without merging', async () => {
    uploadDirectory(source);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'old.jpg'), 'old');

    expect(await result()).toBeInstanceOf(Error);
    expect(fs.readFileSync(path.join(source, 'nested', 'image.jpg'), 'utf8')).toBe('image');
    expect(fs.readdirSync(destination)).toEqual(['old.jpg']);
});

test.each(['directory', 'file'])('EXDEV replaces an existing %s with the upload directory', async kind => {
    acrossDevices();
    uploadDirectory(source);
    if (kind === 'directory') {
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'old.jpg'), 'old');
    } else {
        fs.writeFileSync(destination, 'old file');
    }

    expect(await result()).toBeFalsy();
    expectDirectoryMoved();
    expect(fs.existsSync(path.join(destination, 'old.jpg'))).toBe(false);
});

test.each(['rename', 'EXDEV'])('%s rejects moving a file onto a directory', async method => {
    if (method === 'EXDEV') acrossDevices();
    fs.writeFileSync(source, 'file');
    fs.mkdirSync(destination);

    expect(await result()).toBeInstanceOf(Error);
    expect(fs.readFileSync(source, 'utf8')).toBe('file');
    expect(fs.readdirSync(destination)).toEqual([]);
});

test('rename rejects moving a directory onto a file', async () => {
    uploadDirectory(source);
    fs.writeFileSync(destination, 'old');

    expect(await result()).toBeInstanceOf(Error);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toBe('old');
});

test('non-EXDEV rename errors do not trigger a copy', async () => {
    const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    replace('rename', (source, destination, callback) => queueMicrotask(() => callback(error)));
    fs.writeFileSync(source, 'file');

    expect(await result()).toBe(error);
    expect(fs.readFileSync(source, 'utf8')).toBe('file');
    expect(fs.existsSync(destination)).toBe(false);
});

test.each(['rename', 'EXDEV'])('%s propagates missing source errors', async method => {
    if (method === 'EXDEV') acrossDevices();
    fs.writeFileSync(destination, 'keep');

    expect((await result()).code).toBe('ENOENT');
    expect(fs.readFileSync(destination, 'utf8')).toBe('keep');
});

test.each([
    ['rename', 'file'],
    ['rename', 'directory'],
    ['EXDEV', 'file'],
    ['EXDEV', 'directory']
])('%s does not create missing destination parents for a %s', async (method, kind) => {
    if (method === 'EXDEV') acrossDevices();
    if (kind === 'file') fs.writeFileSync(source, 'file');
    else uploadDirectory(source);
    destination = path.join(root, 'missing', 'file');

    expect((await result()).code).toBe('ENOENT');
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(path.dirname(destination))).toBe(false);
});

test('EXDEV keeps the source when a file copy fails after writing data', async () => {
    acrossDevices();
    const error = Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    fs.writeFileSync(source, 'complete file');
    replace('copyFile', (source, destination, callback) => {
        fs.writeFileSync(destination, 'partial');
        queueMicrotask(() => callback(error));
    });

    expect(await result()).toBe(error);
    expect(fs.readFileSync(source, 'utf8')).toBe('complete file');
});

test('EXDEV keeps the whole source directory when a recursive copy fails', async () => {
    acrossDevices();
    const error = Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    uploadDirectory(source);
    replace('cp', (source, destination, options, callback) => {
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'partial.jpg'), 'partial');
        queueMicrotask(() => callback(error));
    });

    expect(await result()).toBe(error);
    expect(fs.readFileSync(path.join(source, 'nested', 'image.jpg'), 'utf8')).toBe('image');
    expect(fs.readlinkSync(path.join(source, 'image-link'))).toBe('nested/image.jpg');
});

test('EXDEV propagates destination removal errors and keeps the source', async () => {
    acrossDevices();
    const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    uploadDirectory(source);
    fs.writeFileSync(destination, 'keep');
    replace('rm', (target, options, callback) => queueMicrotask(() => callback(error)));

    expect(await result()).toBe(error);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readFileSync(destination, 'utf8')).toBe('keep');
});

test.each(['file', 'directory'])('EXDEV propagates source %s removal errors', async kind => {
    acrossDevices();
    const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    if (kind === 'file') {
        fs.writeFileSync(source, 'file');
        replace('unlink', (target, callback) => queueMicrotask(() => callback(error)));
    } else {
        uploadDirectory(source);
        const remove = fs.rm;
        replace('rm', (target, options, callback) => {
            if (target === source) queueMicrotask(() => callback(error));
            else remove(target, options, callback);
        });
    }

    expect(await result()).toBe(error);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(destination)).toBe(true);
});
