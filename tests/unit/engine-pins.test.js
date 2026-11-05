const { test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '../..');
const pins = fs.readFileSync(path.join(root, 'scripts/engine-sha256sums.txt'), 'utf8');
const rows = pins.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));

test('native engine pin matches the Dockerfile engine', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const engine = dockerfile.match(/^ARG FROM_REPO=ghcr\.io\/aidronemap\/aidm:(\d+\.\d+\.\d+)$/m);
    expect(engine).not.toBeNull();
    expect(rows[0]).toBe(`version ${engine[1]}`);
});

test('engine archive rows name checked Windows variants and the CUDA driver floor', () => {
    const variants = [];
    for (const row of rows.slice(1)) {
        expect(row).toMatch(/^[0-9a-f]{64}  [a-zA-Z0-9._-]+  windows-x64(?:-cuda  \d+\.\d+)?$/);
        variants.push(row.split(/\s+/)[2]);
    }
    expect(variants).toEqual(variants.length ? ['windows-x64', 'windows-x64-cuda'] : []);
});

test('the version guard fails on a mismatched pin in an isolated copy', () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pin-mismatch-'));
    try {
        fs.mkdirSync(path.join(copy, 'tests/unit'), { recursive: true });
        fs.mkdirSync(path.join(copy, 'scripts'));
        fs.copyFileSync(__filename, path.join(copy, 'tests/unit/engine-pins.test.js'));
        fs.copyFileSync(path.join(root, 'Dockerfile'), path.join(copy, 'Dockerfile'));
        const pinned = rows[0].split(' ')[1];
        fs.writeFileSync(path.join(copy, 'scripts/engine-sha256sums.txt'), pins.replace(`version ${pinned}`, 'version 999.0.0'));
        const p = Bun.spawnSync([process.execPath, 'test', 'tests/unit/engine-pins.test.js',
            '--test-name-pattern', '^native engine pin matches the Dockerfile engine$'], { cwd: copy });
        expect(p.exitCode).not.toBe(0);
        expect(p.stderr.toString()).toContain('version 999.0.0');
    } finally {
        fs.rmSync(copy, { recursive: true, force: true });
    }
});
