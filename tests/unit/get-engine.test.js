const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const script = path.join(__dirname, '../../scripts/get_engine.py');
let dir, sums, packages, dest;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-engine-'));
    sums = path.join(dir, 'sums.txt');
    packages = path.join(dir, 'packages');
    dest = path.join(dir, 'dest');
    fs.mkdirSync(packages);
    fs.writeFileSync(path.join(packages, 'cpu.tar.gz'), 'CPU engine bytes');
    fs.writeFileSync(path.join(packages, 'cuda.tar.gz'), 'CUDA engine bytes');
    writeSums();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function writeSums(cpu = sha256(path.join(packages, 'cpu.tar.gz'))) {
    fs.writeFileSync(sums, `version 0.3.0\n${cpu}  cpu.tar.gz  windows-x64\n` +
        `${sha256(path.join(packages, 'cuda.tar.gz'))}  cuda.tar.gz  windows-x64-cuda  576.57\n`);
}
function run(variant = 'windows-x64', file = sums) {
    const p = Bun.spawnSync(['python3', script, variant, dest, '--sums', file], {
        env: { ...process.env, ENGINE_BASE_URL: 'file://' + packages }
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

for (const [variant, asset] of [['windows-x64', 'cpu.tar.gz'], ['windows-x64-cuda', 'cuda.tar.gz']]) {
    test(`downloads and checks ${variant} without unpacking it`, () => {
        const r = run(variant);
        expect(r.code).toBe(0);
        expect(r.out.trim()).toBe(path.join(dest, asset));
        expect(fs.readFileSync(path.join(dest, asset))).toEqual(fs.readFileSync(path.join(packages, asset)));
        expect(fs.readdirSync(dest)).toEqual([asset]);
    });
}

test('a mismatched sum leaves no downloaded archive or temporary file', () => {
    writeSums('0'.repeat(64));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.err).toContain('SHA-256 mismatch for cpu.tar.gz');
    expect(fs.readdirSync(dest)).toEqual([]);
});

test('the current pin reports that no native archive exists without downloading', () => {
    const r = run('windows-x64', path.join(__dirname, '../../scripts/engine-sha256sums.txt'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('has no native archive');
    expect(fs.existsSync(dest)).toBe(false);
});

test('a missing local asset fails without leaving a partial archive', () => {
    fs.unlinkSync(path.join(packages, 'cpu.tar.gz'));
    expect(run().code).toBe(1);
    expect(fs.readdirSync(dest)).toEqual([]);
});

for (const [name, change] of [
    ['invalid version', text => text.replace('0.3.0', 'unknown')],
    ['invalid hash', text => text.replace(/^[a-f0-9]{64}/m, 'invalid')],
    ['unsafe filename', text => text.replaceAll('cpu.tar.gz', '../cpu.tar.gz')],
    ['duplicate variant', text => text + text.split('\n')[1] + '\n'],
    ['missing CUDA floor', text => text.replace('  576.57', '')],
    ['CPU driver floor', text => text.replace('  windows-x64\n', '  windows-x64  576.57\n')],
    ['only one variant', text => text.split('\n').slice(0, 2).join('\n')]
]) {
    test(`refuses ${name} before downloading`, () => {
        fs.writeFileSync(sums, change(fs.readFileSync(sums, 'utf8')));
        expect(run().code).toBe(1);
        expect(fs.existsSync(dest)).toBe(false);
    });
}
