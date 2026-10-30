const { test, expect, beforeAll, afterAll } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const appDir = path.join(__dirname, '..', '..');
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let work;
let root;
let flight;
let outside;
let servers = [];

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

// Starts the API in test mode in its own working folder (tmp/ and tests/data/)
async function startApi(flags) {
    const cwd = fs.mkdtempSync(path.join(work, 'api-'));
    fs.mkdirSync(path.join(cwd, 'tmp'));
    fs.mkdirSync(path.join(cwd, 'tests', 'data'), { recursive: true });
    const port = await freePort();
    const child = Bun.spawn([process.execPath, path.join(appDir, 'index.js'), '--test', '--port', String(port)].concat(flags), {
        cwd, stdout: 'ignore', stderr: 'ignore'
    });
    const api = { cwd, child, url: 'http://127.0.0.1:' + port };
    servers.push(api);
    for (let i = 0; i < 150; i++) {
        try {
            await fetch(api.url + '/info');
            return api;
        } catch (e) {
            await Bun.sleep(100);
        }
    }
    throw new Error('API did not start');
}

async function post(api, route, fields, files) {
    const form = new FormData();
    Object.keys(fields || {}).forEach(k => form.append(k, fields[k]));
    (files || []).forEach(f => form.append('images', new Blob([f.data]), f.name));
    const res = await fetch(api.url + route, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    return res.json();
}

async function postJson(api, route, json) {
    const res = await fetch(api.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
    return res.json();
}

async function waitStatus(api, uuid, code) {
    for (let i = 0; i < 300; i++) {
        const info = await (await fetch(api.url + '/task/' + uuid + '/info')).json();
        if (info.status && info.status.code === code) return info;
        await Bun.sleep(100);
    }
    throw new Error('Task ' + uuid + ' did not reach status ' + code);
}

// Names, sizes and modification times of a folder, and the contents of each file
function snapshot(dir) {
    const out = {};
    fs.readdirSync(dir).sort().forEach(name => {
        const st = fs.lstatSync(path.join(dir, name));
        out[name] = { size: st.size, mtimeMs: st.mtimeMs, dir: st.isDirectory(), link: st.isSymbolicLink() };
        if (st.isFile()) out[name].data = fs.readFileSync(path.join(dir, name)).toString('hex');
    });
    return out;
}

const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
};

beforeAll(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-images-path-')));
    root = path.join(work, 'photos');
    flight = path.join(root, 'flight');
    outside = path.join(work, 'photos2');

    write(path.join(flight, 'IMG_0001.JPG'), 'first image');
    write(path.join(flight, 'img_0002.jpeg'), 'second image');
    write(path.join(flight, 'IMG_0002_mask.png'), 'mask');
    write(path.join(flight, 'clip.MP4'), 'video');
    write(path.join(flight, 'notes.txt'), 'not an image');
    write(path.join(flight, 'sub', 'IMG_0003.JPG'), 'in a subfolder');
    write(path.join(root, 'other', 'IMG_0004.JPG'), 'elsewhere under the root');
    write(path.join(outside, 'flight', 'IMG_0005.JPG'), 'outside the root');
    fs.symlinkSync(path.join(root, 'other', 'IMG_0004.JPG'), path.join(flight, 'linked.jpg'));
    fs.symlinkSync(path.join(outside, 'flight', 'IMG_0005.JPG'), path.join(flight, 'escape.jpg'));
    fs.symlinkSync(path.join(outside, 'flight'), path.join(root, 'escape'));
    write(path.join(root, 'empty', 'readme.txt'), 'no images here');
    write(path.join(root, 'a-file.jpg'), 'a file, not a folder');
    fs.mkdirSync(path.join(root, 'locked'));
    write(path.join(root, 'locked', 'IMG_0006.JPG'), 'locked');
    fs.chmodSync(path.join(root, 'locked'), 0o000);
});

afterAll(() => {
    servers.forEach(api => api.child.kill());
    try { fs.chmodSync(path.join(root, 'locked'), 0o755); } catch (e) { /* ignore */ }
    fs.rmSync(work, { recursive: true, force: true });
});

const TAKEN = ['IMG_0001.JPG', 'IMG_0002_mask.png', 'clip.MP4', 'img_0002.jpeg', 'linked.jpg'];

test('a task from a folder: links in, source untouched, links gone with the task', async () => {
    const api = await startApi(['--images_root', root]);
    const info = await (await fetch(api.url + '/info')).json();
    expect(info.imagesPath).toBe(true);

    const before = snapshot(flight);
    const init = await post(api, '/task/new/init', { name: 'from a folder', imagesPath: flight });
    expect(init.error).toBeUndefined();
    const uuid = init.uuid;

    // The links are in the staging folder before the response
    const staging = path.join(api.cwd, 'tmp', uuid);
    expect(fs.readdirSync(staging).filter(n => n !== 'body.json').sort()).toEqual(TAKEN);

    // A ground control file uploaded next to the folder lands where uploads do
    expect(await post(api, '/task/new/upload/' + uuid, {}, [{ name: 'gcp_list.txt', data: 'EPSG:4326\n' }])).toEqual({ success: true });
    const commit = await post(api, '/task/new/commit/' + uuid);
    expect(commit).toEqual({ uuid });

    const done = await waitStatus(api, uuid, 40);
    expect(done.imagesCount).toBe(TAKEN.length);

    const project = path.join(api.cwd, 'tests', 'data', uuid);
    const images = path.join(project, 'images');
    expect(fs.readdirSync(images).sort()).toEqual(TAKEN);
    expect(fs.readdirSync(path.join(project, 'gcp'))).toEqual(['gcp_list.txt']);
    for (const name of TAKEN) {
        const entry = fs.lstatSync(path.join(images, name));
        const source = fs.statSync(fs.realpathSync(path.join(flight, name)));
        expect(entry.isFile()).toBe(true);
        expect(entry.ino).toBe(source.ino);
        expect(entry.nlink).toBeGreaterThan(1);
    }
    expect(snapshot(flight)).toEqual(before);

    // A restart reuses the images folder, links included
    expect(await postJson(api, '/task/restart', { uuid })).toEqual({ success: true });
    await waitStatus(api, uuid, 40);
    expect(fs.readdirSync(images).sort()).toEqual(TAKEN);

    expect(await postJson(api, '/task/remove', { uuid })).toEqual({ success: true });
    expect(fs.existsSync(project)).toBe(false);
    expect(snapshot(flight)).toEqual(before);
    expect(fs.readFileSync(path.join(root, 'other', 'IMG_0004.JPG'), 'utf8')).toBe('elsewhere under the root');
});

test('a task from a folder in one request, with an upload next to it', async () => {
    const api = await startApi(['--images_root', root]);
    const before = snapshot(flight);
    const created = await post(api, '/task/new', { imagesPath: flight + path.sep }, [{ name: 'gcp_list.txt', data: 'EPSG:4326\n' }]);
    expect(created.error).toBeUndefined();

    await waitStatus(api, created.uuid, 40);
    const project = path.join(api.cwd, 'tests', 'data', created.uuid);
    expect(fs.readdirSync(path.join(project, 'images')).sort()).toEqual(TAKEN);
    expect(fs.readdirSync(path.join(project, 'gcp'))).toEqual(['gcp_list.txt']);

    expect(await postJson(api, '/task/remove', { uuid: created.uuid })).toEqual({ success: true });
    expect(fs.existsSync(project)).toBe(false);
    expect(snapshot(flight)).toEqual(before);
});

test('without --images_root, /info has no imagesPath key and the field is refused', async () => {
    const api = await startApi([]);
    const info = await (await fetch(api.url + '/info')).json();
    expect('imagesPath' in info).toBe(false);

    const error = 'imagesPath is not enabled on this node. Start the node with --images_root to enable it.';
    expect(await post(api, '/task/new/init', { imagesPath: flight })).toEqual({ error });
    expect(await post(api, '/task/new', { imagesPath: flight })).toEqual({ error });
    expect(await post(api, '/task/new', { imagesPath: flight }, [{ name: 'a.JPG', data: 'upload' }])).toEqual({ error });
    await Bun.sleep(100);
    expect(fs.readdirSync(path.join(api.cwd, 'tmp'))).toEqual([]);
});

const refusals = [
    ['a folder next to the root that shares its prefix', () => path.join(outside, 'flight'), 'imagesPath is outside the images root.'],
    ['the parent of the root', () => work, 'imagesPath is outside the images root.'],
    ['a path that does not exist outside the root', () => path.join(outside, 'missing'), 'imagesPath is outside the images root.'],
    ['a symbolic link inside the root to a folder outside it', () => path.join(root, 'escape'), 'imagesPath is outside the images root.'],
    ['a path that does not exist', () => path.join(root, 'missing'), 'Cannot read imagesPath: it does not exist.'],
    ['a file', () => path.join(root, 'a-file.jpg'), 'Cannot read imagesPath: it is not a folder.'],
    ['a folder without supported files', () => path.join(root, 'empty'), 'imagesPath holds no supported image or video file.']
];
if (!asRoot) refusals.push(['a folder that cannot be read', () => path.join(root, 'locked'), 'Cannot read imagesPath: permission denied.']);

test.each(refusals)('refuses %s at init and at /task/new', async (what, folder, error) => {
    const api = await startApi(['--images_root', root]);
    expect(await post(api, '/task/new/init', { imagesPath: folder() })).toEqual({ error });
    expect(await post(api, '/task/new', { imagesPath: folder() })).toEqual({ error });
    expect(await post(api, '/task/new', { imagesPath: folder() }, [{ name: 'gcp_list.txt', data: 'EPSG:4326\n' }])).toEqual({ error });
    // Nothing is left in the staging folder
    await Bun.sleep(100);
    expect(fs.readdirSync(path.join(api.cwd, 'tmp'))).toEqual([]);
});

test('refuses imagesPath with zipurl', async () => {
    const api = await startApi(['--images_root', root]);
    const error = 'imagesPath and zipurl cannot both be set.';
    expect(await post(api, '/task/new/init', { imagesPath: flight, zipurl: 'http://127.0.0.1:1/x.zip' })).toEqual({ error });
    expect(await post(api, '/task/new', { imagesPath: flight, zipurl: 'http://127.0.0.1:1/x.zip' })).toEqual({ error });
    await Bun.sleep(100);
    expect(fs.readdirSync(path.join(api.cwd, 'tmp'))).toEqual([]);
});

test('the images root can come from the config file', async () => {
    const file = path.join(work, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ imagesRoot: root }));
    const api = await startApi(['--config', file]);
    const info = await (await fetch(api.url + '/info')).json();
    expect(info.imagesPath).toBe(true);
    const init = await post(api, '/task/new/init', { imagesPath: flight });
    expect(init.error).toBeUndefined();
    expect(fs.readdirSync(path.join(api.cwd, 'tmp', init.uuid)).filter(n => n !== 'body.json').sort()).toEqual(TAKEN);
});

test('refuses imagesPath sent twice or with a NUL byte, and keeps answering', async () => {
    const api = await startApi(['--images_root', root]);
    const error = 'Cannot read imagesPath: it is not a valid path.';
    const form = new FormData();
    form.append('imagesPath', flight);
    form.append('imagesPath', flight);
    expect(await (await fetch(api.url + '/task/new/init', { method: 'POST', body: form })).json()).toEqual({ error });
    expect(await post(api, '/task/new', { imagesPath: flight + '\0' })).toEqual({ error });
    expect(await post(api, '/task/new/init', { imagesPath: flight + '\0' })).toEqual({ error });
    expect((await (await fetch(api.url + '/info')).json()).imagesPath).toBe(true);
});
