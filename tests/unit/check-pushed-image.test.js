// Checks scripts/check-pushed-image.sh, which the release workflow runs after
// it pushes an image. It must accept the image id in both forms Docker
// reports, and reject anything else.
const { test, expect } = require('bun:test');
const path = require('path');

const script = path.join(__dirname, '..', '..', 'scripts', 'check-pushed-image.sh');

const CONFIG = 'sha256:' + 'c'.repeat(64);
const MANIFEST = 'sha256:' + 'm'.repeat(64);
const OTHER = 'sha256:' + '0'.repeat(64);

function check(...args) {
    const p = Bun.spawnSync(['bash', script, ...args]);
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

test('passes on the config digest (classic image store)', () => {
    const { code, out } = check(CONFIG, CONFIG, MANIFEST);
    expect(code).toBe(0);
    expect(out).toContain('config digest');
});

// Docker 29 on the GitHub runners: the build step reports the manifest
// digest, the push step's imageid is the config digest
test('passes on the manifest digest (containerd image store)', () => {
    const { code, out } = check(MANIFEST, CONFIG, MANIFEST);
    expect(code).toBe(0);
    expect(out).toContain('manifest digest');
});

test('fails when the pushed image is a different one', () => {
    const { code, out } = check(OTHER, CONFIG, MANIFEST);
    expect(code).toBe(1);
    expect(out).toContain('::error::');
});

test('fails when the tested id is empty', () => {
    expect(check('', CONFIG, MANIFEST).code).toBe(1);
    expect(check('', '', '').code).toBe(1);
});

test('fails when the push step reported nothing', () => {
    expect(check(CONFIG, '', '').code).toBe(1);
});

test('exits 2 on wrong arguments', () => {
    expect(check(CONFIG).code).toBe(2);
});
