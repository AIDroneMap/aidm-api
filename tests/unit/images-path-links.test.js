// In-process checks of libs/imagesPath.js and libs/move.js. The config is
// replaced, as in ziputils.test.js: Bun copies the object a mock returns and
// keeps module mocks for the whole run, so each test loads a fresh
// imagesPath with the images root it needs.
const { test, expect, mock, beforeEach, afterEach, spyOn } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const move = require('../../libs/move');

const configPath = path.join(__dirname, '..', '..', 'config.js');
const imagesPathPath = path.join(__dirname, '..', '..', 'libs', 'imagesPath.js');

let work;
let root;
let flight;
let spies;
let imagesPath;

function loadImagesPath(imagesRoot) {
    mock.module(configPath, () => ({ imagesRoot }));
    delete require.cache[imagesPathPath];
    imagesPath = require(imagesPathPath);
}

beforeEach(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-images-links-')));
    root = path.join(work, 'photos');
    flight = path.join(root, 'flight');
    fs.mkdirSync(flight, { recursive: true });
    fs.writeFileSync(path.join(flight, 'IMG_0001.JPG'), 'first');
    fs.writeFileSync(path.join(flight, 'IMG_0002.dng'), 'second');
    fs.mkdirSync(path.join(work, 'staging'));
    loadImagesPath(root);
    spies = [];
});

afterEach(() => {
    spies.forEach(spy => spy.mockRestore());
    fs.rmSync(work, { recursive: true, force: true });
});

const linkInto = (body, dir) => new Promise(resolve => imagesPath.linkInto(body, dir, resolve));
const hardLinks = (body, dir) => new Promise((resolve, reject) => imagesPath.hardLinks(body, dir, (err, links) => err ? reject(err) : resolve(links)));
const moveWith = (source, destination, links) => new Promise(resolve => move(source, destination, links, imagesPath.link, resolve));

function noHardLinks() {
    spies.push(spyOn(fs, 'link').mockImplementation((source, destination, callback) => {
        queueMicrotask(() => callback(Object.assign(new Error('Cross-device link'), { code: 'EXDEV' })));
    }));
}

function acrossDevices() {
    spies.push(spyOn(fs, 'rename').mockImplementation((source, destination, callback) => {
        queueMicrotask(() => callback(Object.assign(new Error('Cross-device move'), { code: 'EXDEV' })));
    }));
}

test('the accepted extensions are the engine 0.2.0 image and video lists', () => {
    expect([...imagesPath.EXTENSIONS].sort()).toEqual([
        '.bmp', '.dng', '.jpeg', '.jpg', '.jxl', '.lrv', '.mov', '.mp4', '.nef', '.png', '.raw', '.tif', '.tiff', '.ts'
    ]);
});

test('a hard link that cannot be made becomes an absolute symbolic link', async () => {
    noHardLinks();
    const staging = path.join(work, 'staging');
    expect(await linkInto({ imagesPath: flight }, staging)).toBeFalsy();

    for (const name of ['IMG_0001.JPG', 'IMG_0002.dng']) {
        const entry = path.join(staging, name);
        expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(entry)).toBe(path.join(flight, name));
    }
});

test('a link that cannot be made fails with an error for the response', async () => {
    const staging = path.join(work, 'staging');
    fs.writeFileSync(path.join(staging, 'IMG_0001.JPG'), 'an upload with the same name');
    const err = await linkInto({ imagesPath: flight }, staging);
    expect(err.message).toBe('Cannot link IMG_0001.JPG into the task: a file with that name exists.');
    expect(fs.readFileSync(path.join(flight, 'IMG_0001.JPG'), 'utf8')).toBe('first');
});

test('hardLinks finds only entries that are the same file as the source', async () => {
    const staging = path.join(work, 'staging');
    expect(await linkInto({ imagesPath: flight }, staging)).toBeFalsy();
    fs.writeFileSync(path.join(staging, 'upload.jpg'), 'an upload');

    // An entry named like a source file but not linked to it does not count
    fs.unlinkSync(path.join(staging, 'IMG_0002.dng'));
    fs.writeFileSync(path.join(staging, 'IMG_0002.dng'), 'replaced');
    fs.linkSync(path.join(staging, 'IMG_0002.dng'), path.join(work, 'second-name'));

    const links = await hardLinks({ imagesPath: flight }, staging);
    expect([...links]).toEqual([['IMG_0001.JPG', path.join(flight, 'IMG_0001.JPG')]]);

    expect((await hardLinks({}, staging)).size).toBe(0);
    loadImagesPath('');
    expect((await hardLinks({ imagesPath: flight }, staging)).size).toBe(0);
});

test('a move across devices keeps hard links and symbolic links as links', async () => {
    const staging = path.join(work, 'staging');
    expect(await linkInto({ imagesPath: flight }, staging)).toBeFalsy();
    fs.unlinkSync(path.join(staging, 'IMG_0002.dng'));
    fs.symlinkSync(path.join(flight, 'IMG_0002.dng'), path.join(staging, 'IMG_0002.dng'));
    fs.writeFileSync(path.join(staging, 'gcp_list.txt'), 'an upload');

    const links = await hardLinks({ imagesPath: flight }, staging);
    acrossDevices();
    const images = path.join(work, 'images');
    expect(await moveWith(staging, images, links)).toBeFalsy();

    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.statSync(path.join(images, 'IMG_0001.JPG')).ino).toBe(fs.statSync(path.join(flight, 'IMG_0001.JPG')).ino);
    expect(fs.readlinkSync(path.join(images, 'IMG_0002.dng'))).toBe(path.join(flight, 'IMG_0002.dng'));
    expect(fs.readFileSync(path.join(images, 'gcp_list.txt'), 'utf8')).toBe('an upload');
    expect(fs.readFileSync(path.join(flight, 'IMG_0001.JPG'), 'utf8')).toBe('first');
});

test('a move across devices makes a symbolic link where the hard link cannot follow', async () => {
    const staging = path.join(work, 'staging');
    expect(await linkInto({ imagesPath: flight }, staging)).toBeFalsy();
    const links = await hardLinks({ imagesPath: flight }, staging);
    expect(links.size).toBe(2);

    acrossDevices();
    noHardLinks();
    const images = path.join(work, 'images');
    expect(await moveWith(staging, images, links)).toBeFalsy();

    for (const name of ['IMG_0001.JPG', 'IMG_0002.dng']) {
        expect(fs.readlinkSync(path.join(images, name))).toBe(path.join(flight, name));
    }
});

test('a move across devices that cannot make a link keeps the staging folder', async () => {
    const staging = path.join(work, 'staging');
    expect(await linkInto({ imagesPath: flight }, staging)).toBeFalsy();
    const links = await hardLinks({ imagesPath: flight }, staging);

    acrossDevices();
    const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const err = await new Promise(resolve => move(staging, path.join(work, 'images'), links, (s, d, cb) => cb(error), resolve));
    expect(err).toBe(error);
    expect(fs.readdirSync(staging).sort()).toEqual(['IMG_0001.JPG', 'IMG_0002.dng']);
});
