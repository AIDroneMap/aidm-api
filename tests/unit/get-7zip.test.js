// Checks scripts/get-7zip.sh, which scripts/package.sh runs to put 7-Zip in
// each release archive. The packages come from a local folder through
// SEVENZIP_BASE_URL, so the test needs no network.
const { test, expect, beforeEach, afterEach } = require('bun:test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, '..', '..', 'scripts', 'get-7zip.sh');
const pins = path.join(__dirname, '..', '..', 'scripts', '7zip-sha256sums.txt');
const LINUX_X64 = '7z2605-linux-x64.tar.xz';
const LINUX_ARM64 = '7z2605-linux-arm64.tar.xz';
const EXTRA = '7z2605-extra.7z';

let dir;
let packages;
let dest;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-7zip-'));
    packages = path.join(dir, 'packages');
    dest = path.join(dir, 'dest');
    fs.mkdirSync(packages);
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// A Linux package with the files the real one has at its top level. Its 7zzs
// is a shell script that unpacks the Extra package the way 7zzs is called.
function linuxPackage(asset, licence) {
    const content = path.join(dir, 'content-' + asset);
    fs.mkdirSync(content);
    fs.writeFileSync(path.join(content, '7zzs'), [
        '#!/bin/sh',
        'for a in "$@"; do case "$a" in -o*) out="${a#-o}" ;; esac; done',
        'mkdir -p "$out/x64"',
        'echo "7za for x64" > "$out/x64/7za.exe"',
        'echo "Extra licence" > "$out/License.txt"',
        ''
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(content, '7zz'), 'dynamic build\n');
    fs.writeFileSync(path.join(content, 'License.txt'), licence + '\n');
    fs.writeFileSync(path.join(content, 'readme.txt'), 'readme\n');
    const p = Bun.spawnSync(['tar', '-cJf', path.join(packages, asset), '-C', content, '7zz', '7zzs', 'readme.txt', 'License.txt']);
    expect(p.exitCode).toBe(0);
}

function writeSums(assets) {
    const file = path.join(dir, 'sums.txt');
    fs.writeFileSync(file, assets.map(a => sha256(path.join(packages, a)) + '  ' + a).join('\n') + '\n');
    return file;
}

function run(platform, sums) {
    const env = Object.assign({}, process.env, { SEVENZIP_BASE_URL: 'file://' + packages });
    if (sums) env.SEVENZIP_SUMS = sums;
    const p = Bun.spawnSync(['bash', script, platform, dest], { env });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

test('the pins name the three packages, each with a SHA-256', () => {
    const lines = fs.readFileSync(pins, 'utf8').trim().split('\n');
    const assets = lines.map(l => {
        expect(l).toMatch(/^[0-9a-f]{64}  \S+$/);
        return l.split('  ')[1];
    });
    expect(assets.sort()).toEqual([EXTRA, LINUX_ARM64, LINUX_X64]);
});

test('fails on a checksum mismatch and writes nothing', () => {
    // A package that is not the pinned one, checked against the real pins
    linuxPackage(LINUX_X64, 'changed');
    const r = run('linux-x64');
    expect(r.code).toBe(1);
    expect(r.err).toContain('SHA-256 mismatch for ' + LINUX_X64);
    expect(fs.existsSync(path.join(dest, '7zzs'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'License.txt'))).toBe(false);
});

test('Windows: fails on a checksum mismatch of the Extra package', () => {
    linuxPackage(LINUX_X64, 'Linux licence');
    fs.writeFileSync(path.join(packages, EXTRA), 'extra package');
    const sums = writeSums([LINUX_X64]);
    fs.appendFileSync(sums, '0'.repeat(64) + '  ' + EXTRA + '\n');
    const r = run('windows-x64', sums);
    expect(r.code).toBe(1);
    expect(r.err).toContain('SHA-256 mismatch for ' + EXTRA);
    expect(fs.existsSync(path.join(dest, '7za.exe'))).toBe(false);
});

test('fails when the checksum file has no line for the package', () => {
    linuxPackage(LINUX_X64, 'Linux licence');
    const sums = path.join(dir, 'sums.txt');
    fs.writeFileSync(sums, '');
    const r = run('linux-x64', sums);
    expect(r.code).toBe(1);
    expect(r.err).toContain('has no line for ' + LINUX_X64);
});

test('Linux: unpacks 7zzs and the licence of its own package', () => {
    linuxPackage(LINUX_ARM64, 'Linux licence with the unRAR restriction');
    const r = run('linux-arm64', writeSums([LINUX_ARM64]));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(path.join(dest, '7zzs'));
    expect(fs.readdirSync(dest).sort()).toEqual(['7zzs', 'License.txt', 'source.txt']);
    expect(fs.statSync(path.join(dest, '7zzs')).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(path.join(dest, 'License.txt'), 'utf8')).toBe('Linux licence with the unRAR restriction\n');
    expect(fs.readFileSync(path.join(dest, 'source.txt'), 'utf8')).toBe(
        'file://' + packages + '/' + LINUX_ARM64 + '\n' + 'file://' + packages + '/7z2605-src.tar.xz\n'
    );
});

test('Windows: opens the Extra package with the Linux x64 7zzs and keeps its licence', () => {
    linuxPackage(LINUX_X64, 'Linux licence');
    fs.writeFileSync(path.join(packages, EXTRA), 'extra package');
    const r = run('windows-x64', writeSums([LINUX_X64, EXTRA]));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(path.join(dest, '7za.exe'));
    expect(fs.readdirSync(dest).sort()).toEqual(['7za.exe', 'License.txt', 'source.txt']);
    expect(fs.readFileSync(path.join(dest, '7za.exe'), 'utf8')).toBe('7za for x64\n');
    expect(fs.readFileSync(path.join(dest, 'License.txt'), 'utf8')).toBe('Extra licence\n');
    expect(fs.readFileSync(path.join(dest, 'source.txt'), 'utf8').split('\n')[0]).toBe('file://' + packages + '/' + EXTRA);
});

test('exits 2 on an unknown platform or wrong arguments', () => {
    expect(run('linux-x86').code).toBe(2);
    const p = Bun.spawnSync(['bash', script, 'linux-x64']);
    expect(p.exitCode).toBe(2);
});
