// Checks which zip programs libs/apps.js picks. A compiled executable uses the
// 7-Zip bundled next to it first; otherwise the programs come from the PATH.
const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const apps = require('../../libs/apps');

let root;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-apps-'));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function bundle(name) {
    fs.mkdirSync(path.join(root, 'apps', '7z'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', '7z', name), '');
    return path.join(root, 'apps', '7z', name);
}

const PATH_ONLY = { sevenZ: '7z', unzip: 'unzip', bundledSevenZ: false };

test('compiled on Linux with a bundled 7zzs: uses it first', () => {
    const file = bundle('7zzs');
    expect(apps.lookup({ compiled: true, root, platform: 'linux' }))
        .toEqual({ sevenZ: file, unzip: 'unzip', bundledSevenZ: true });
});

test('compiled on Windows with a bundled 7za.exe: uses it first', () => {
    const file = bundle('7za.exe');
    expect(apps.lookup({ compiled: true, root, platform: 'win32' }))
        .toEqual({ sevenZ: file, unzip: 'unzip', bundledSevenZ: true });
});

test('compiled without a bundled tool: the PATH', () => {
    expect(apps.lookup({ compiled: true, root, platform: 'linux' })).toEqual(PATH_ONLY);
    expect(apps.lookup({ compiled: true, root, platform: 'win32' })).toEqual(PATH_ONLY);
});

test('compiled with the other platform\'s tool: the PATH', () => {
    bundle('7za.exe');
    expect(apps.lookup({ compiled: true, root, platform: 'linux' })).toEqual(PATH_ONLY);
});

test('source mode: the PATH, even with an apps folder', () => {
    bundle('7zzs');
    bundle('7za.exe');
    bundle('7z.exe');
    expect(apps.lookup({ compiled: false, root, platform: 'linux' })).toEqual(PATH_ONLY);
    expect(apps.lookup({ compiled: false, root, platform: 'win32' })).toEqual(PATH_ONLY);
});

test('the unit tests run from source, so the module uses the PATH', () => {
    expect({ sevenZ: apps.sevenZ, unzip: apps.unzip, bundledSevenZ: apps.bundledSevenZ }).toEqual(PATH_ONLY);
});
