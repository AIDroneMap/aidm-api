// Checks scripts/release-manifest.js, which builds, signs and verifies the
// release manifest. The size rule, the sequence rule and the JSON writer are
// plain functions, called here directly. The command line runs against a
// stored image manifest through a stand-in "docker", so no test reads a
// registry.
const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const script = path.join(root, 'scripts', 'release-manifest.js');
const fixture = path.join(__dirname, 'fixtures', 'image-manifest.json');
const lib = require(script);

const IMAGE = 'ghcr.io/aidronemap/aidm-api';
const DIGESTS = {
    'cpu-amd64': 'sha256:' + 'a'.repeat(64),
    'cpu-arm64': 'sha256:' + 'b'.repeat(64),
    'gpu-amd64': 'sha256:' + 'c'.repeat(64)
};
// 7023 (config) + 29724517 + 412903288 + 1048 (layers) in the fixture
const FIXTURE_SIZE = 442635876;

function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'release-manifest-'));
}

function keyPair() {
    const dir = tmp();
    const pem = path.join(dir, 'key.pem');
    expect(Bun.spawnSync(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', pem]).exitCode).toBe(0);
    const der = Bun.spawnSync(['openssl', 'pkey', '-in', pem, '-pubout', '-outform', 'DER']).stdout;
    // The last 32 bytes of the DER public key are the raw key
    const publicKey = Buffer.from(der.subarray(der.length - 32)).toString('base64');
    return { pem: fs.readFileSync(pem, 'utf8'), publicKey };
}

const baseArgs = {
    version: '2.7.0',
    engineVersion: '0.2.0',
    minimumUiVersion: '0.1.0',
    image: IMAGE,
    digests: DIGESTS,
    sizeOf: () => FIXTURE_SIZE
};

function manifestText() {
    return new TextDecoder().decode(lib.renderManifest(lib.buildManifest(baseArgs)));
}

test('sequence is major x 1,000,000 + minor x 1,000 + patch', () => {
    expect(lib.sequenceFor('2.7.0')).toBe(2007000);
    expect(lib.sequenceFor('2.6.1')).toBe(2006001);
    expect(lib.sequenceFor('0.0.1')).toBe(1);
    expect(lib.sequenceFor('10.20.30')).toBe(10020030);
    expect(lib.sequenceFor('2.7.0')).toBeGreaterThan(lib.sequenceFor('2.6.1'));
});

test('sequence refuses a version it cannot place', () => {
    for (const bad of ['', '2.7', '2.7.0.1', 'v2.7.0', '2.7.0-rc1', '02.7.0', '0.0.0', '1.1000.0', '1.0.1000']) {
        expect(() => lib.sequenceFor(bad)).toThrow();
    }
});

test('size is the config plus every compressed layer of the image manifest', () => {
    const doc = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    expect(lib.imageSize(doc)).toBe(FIXTURE_SIZE);
});

test('size refuses an index and incomplete documents', () => {
    const doc = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    expect(() => lib.imageSize({ schemaVersion: 2, manifests: [{ digest: DIGESTS['cpu-amd64'], size: 400 }] })).toThrow(
        /index/
    );
    expect(() => lib.imageSize({ ...doc, layers: [] })).toThrow();
    expect(() => lib.imageSize({ ...doc, config: undefined })).toThrow();
    expect(() => lib.imageSize({ ...doc, layers: [{ size: '5' }] })).toThrow();
    expect(() => lib.imageSize(null)).toThrow();
});

test('the manifest has the fields and variants aidm-ui reads', () => {
    const m = JSON.parse(manifestText());
    expect(Object.keys(m)).toEqual([
        'schemaVersion',
        'sequence',
        'packageVersion',
        'engineVersion',
        'minimumUiVersion',
        'variants'
    ]);
    expect(m.schemaVersion).toBe(1);
    expect(m.sequence).toBe(2007000);
    expect(m.packageVersion).toBe('2.7.0');
    expect(m.engineVersion).toBe('0.2.0');
    expect(m.minimumUiVersion).toBe('0.1.0');
    expect(Object.keys(m.variants)).toEqual(['linux-amd64-cpu', 'linux-arm64-cpu', 'linux-amd64-gpu']);
    expect(m.variants['linux-arm64-cpu']).toEqual({
        kind: 'container',
        image: IMAGE,
        digest: DIGESTS['cpu-arm64'],
        size: FIXTURE_SIZE,
        gpu: false,
        taskApiSocket: true
    });
    expect(m.variants['linux-amd64-gpu'].gpu).toBe(true);
    expect(m.variants['linux-amd64-gpu'].digest).toBe(DIGESTS['gpu-amd64']);
    expect(m.variants['linux-amd64-cpu'].gpu).toBe(false);
});

test('the output is fixed: two-space JSON, one newline at the end', () => {
    const text = manifestText();
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).toContain('\n  "schemaVersion": 1,\n  "sequence": 2007000,\n');
    expect(text).toContain('\n      "kind": "container",\n      "image": "ghcr.io/aidronemap/aidm-api",\n');
});

test('repeated builds give the same bytes', () => {
    const a = lib.renderManifest(lib.buildManifest(baseArgs));
    const b = lib.renderManifest(lib.buildManifest({ ...baseArgs, digests: { ...DIGESTS } }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
});

test('build refuses bad input', () => {
    const bad = (change) => () => lib.buildManifest({ ...baseArgs, ...change });
    expect(bad({ version: '2.7' })).toThrow();
    expect(bad({ engineVersion: 'latest' })).toThrow();
    expect(bad({ minimumUiVersion: undefined })).toThrow();
    expect(bad({ image: IMAGE + ':2.7.0' })).toThrow();
    expect(bad({ image: '-oops/image' })).toThrow();
    expect(bad({ digests: { ...DIGESTS, 'gpu-amd64': 'sha256:abc' } })).toThrow(/gpu-amd64/);
    expect(bad({ digests: { ...DIGESTS, 'cpu-arm64': undefined } })).toThrow(/cpu-arm64/);
    expect(bad({ sizeOf: () => 0 })).toThrow();
});

test('sign and verify round trip, and the signature is 64 raw bytes', async () => {
    const { pem, publicKey } = keyPair();
    const bytes = lib.renderManifest(lib.buildManifest(baseArgs));
    const signature = await lib.signBytes(bytes, pem);
    expect(signature.length).toBe(64);
    expect(await lib.verifyBytes(bytes, signature, publicKey + '\n')).toBe(true);
});

test('verify refuses another key, an altered manifest and a short signature', async () => {
    const one = keyPair();
    const other = keyPair();
    const bytes = lib.renderManifest(lib.buildManifest(baseArgs));
    const signature = await lib.signBytes(bytes, one.pem);
    expect(await lib.verifyBytes(bytes, signature, other.publicKey)).toBe(false);
    const altered = Buffer.from(bytes);
    altered[altered.length - 3] ^= 1;
    expect(await lib.verifyBytes(altered, signature, one.publicKey)).toBe(false);
    expect(await lib.verifyBytes(bytes, signature.subarray(0, 63), one.publicKey)).toBe(false);
});

test('the public key file must be one base64 line of 32 bytes', () => {
    const { publicKey } = keyPair();
    expect(lib.parsePublicKey(publicKey).length).toBe(32);
    expect(() => lib.parsePublicKey('')).toThrow();
    expect(() => lib.parsePublicKey('AAAA')).toThrow();
    expect(() => lib.parsePublicKey(publicKey + publicKey)).toThrow();
});

test('sign refuses a key that is not a PKCS#8 PEM', async () => {
    await expect(lib.signBytes(new Uint8Array([1]), 'not a key')).rejects.toThrow();
});

// The command line, with a "docker" on the path that serves the stored image manifest
function run(args, { stdin, path: extraPath } = {}) {
    const p = Bun.spawnSync(['bun', script, ...args], {
        stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
        env: { ...process.env, PATH: (extraPath ? extraPath + path.delimiter : '') + process.env.PATH }
    });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

function fakeDocker(body) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
    return dir;
}

function digestFolder() {
    const dir = tmp();
    for (const [name, digest] of Object.entries(DIGESTS)) fs.writeFileSync(path.join(dir, name), digest + '\n');
    return dir;
}

test('command line: build, sign and verify end to end', () => {
    const dir = tmp();
    const bin = fakeDocker(`cat "${fixture}"`);
    const { pem, publicKey } = keyPair();
    const manifest = path.join(dir, 'manifest.json');
    const sig = path.join(dir, 'manifest.json.sig');
    const pub = path.join(dir, 'public-key.txt');
    fs.writeFileSync(pub, publicKey + '\n');

    const build = (out) =>
        run(
            ['build', '--engine-version', '0.2.0', '--image', IMAGE, '--digests', digestFolder(), '--out', out],
            { path: bin }
        );
    expect(build(manifest).code).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    expect(m.packageVersion).toBe(pkg.version);
    expect(m.minimumUiVersion).toBe(pkg.minimumUiVersion);
    expect(m.sequence).toBe(lib.sequenceFor(pkg.version));
    expect(m.variants['linux-amd64-cpu'].size).toBe(FIXTURE_SIZE);

    const second = path.join(dir, 'second.json');
    expect(build(second).code).toBe(0);
    expect(fs.readFileSync(second).equals(fs.readFileSync(manifest))).toBe(true);

    expect(run(['sign', '--manifest', manifest, '--out', sig], { stdin: pem }).code).toBe(0);
    expect(fs.statSync(sig).size).toBe(64);
    const ok = run(['verify', '--manifest', manifest, '--signature', sig, '--public-key', pub]);
    expect(ok.code).toBe(0);

    fs.writeFileSync(pub, keyPair().publicKey + '\n');
    const refused = run(['verify', '--manifest', manifest, '--signature', sig, '--public-key', pub]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('does not match');
});

test('command line: build fails clearly when the registry returns an index', () => {
    const bin = fakeDocker(`echo '{"schemaVersion":2,"manifests":[{"digest":"sha256:${'d'.repeat(64)}","size":400}]}'`);
    const out = path.join(tmp(), 'manifest.json');
    const r = run(['build', '--engine-version', '0.2.0', '--image', IMAGE, '--digests', digestFolder(), '--out', out], {
        path: bin
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('index');
    expect(fs.existsSync(out)).toBe(false);
});

test('command line: build fails when the registry lookup fails or a digest file is missing', () => {
    const out = path.join(tmp(), 'manifest.json');
    const args = (folder) => ['build', '--engine-version', '0.2.0', '--image', IMAGE, '--digests', folder, '--out', out];
    const down = run(args(digestFolder()), { path: fakeDocker('echo "manifest unknown" >&2; exit 1') });
    expect(down.code).toBe(1);
    expect(down.out).toContain('manifest unknown');

    const folder = digestFolder();
    fs.rmSync(path.join(folder, 'gpu-amd64'));
    const missing = run(args(folder), { path: fakeDocker(`cat "${fixture}"`) });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('gpu-amd64');
    expect(fs.existsSync(out)).toBe(false);
});

test('command line: unknown command and missing options exit 1 with the usage', () => {
    expect(run(['frobnicate']).out).toContain('Usage:');
    expect(run(['build']).code).toBe(1);
    expect(run([]).code).toBe(1);
});
