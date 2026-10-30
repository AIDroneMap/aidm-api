// Checks that scripts/third-party-notices.js copies the licence of the bundled
// 7-Zip from the folder scripts/get-7zip.sh fills, so the notices carry the
// text of the exact package in the archive.
const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, '..', '..', 'scripts', 'third-party-notices.js');

let dir;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-notices-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function sevenZip(binary, licence) {
    const folder = path.join(dir, '7zip');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, binary), '');
    fs.writeFileSync(path.join(folder, 'License.txt'), licence);
    fs.writeFileSync(path.join(folder, 'source.txt'), 'https://example.org/pkg.tar.xz\nhttps://example.org/src.tar.xz\n');
    return folder;
}

function notices(...args) {
    const out = path.join(dir, 'NOTICES.txt');
    const p = Bun.spawnSync([process.execPath, script, ...args, out]);
    return { code: p.exitCode, err: p.stderr.toString(), text: p.exitCode === 0 ? fs.readFileSync(out, 'utf8') : '' };
}

test('carries the 7-Zip licence text of the package', () => {
    const folder = sevenZip('7zzs', '  7-Zip for Linux\r\n  unRAR license restriction\r\n');
    const r = notices('--7zip', folder);
    expect(r.code).toBe(0);
    expect(r.text).toContain('apps/7z/7zzs is the official 7-Zip build from\nhttps://example.org/pkg.tar.xz\n');
    expect(r.text).toContain('https://example.org/src.tar.xz');
    expect(r.text).toContain('  7-Zip for Linux\n  unRAR license restriction\n');
});

test('names the Windows executable', () => {
    const r = notices('--7zip', sevenZip('7za.exe', 'Extra licence'));
    expect(r.code).toBe(0);
    expect(r.text).toContain('apps/7z/7za.exe is the official 7-Zip build from');
});

test('fails when the folder has no licence', () => {
    const folder = sevenZip('7zzs', 'x');
    fs.unlinkSync(path.join(folder, 'License.txt'));
    const r = notices('--7zip', folder);
    expect(r.code).toBe(1);
    expect(r.err).toContain('License.txt');
});

test('without --7zip there is no 7-Zip section', () => {
    const r = notices();
    expect(r.code).toBe(0);
    expect(r.text).not.toContain('7-Zip');
});
