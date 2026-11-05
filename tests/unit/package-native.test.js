const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '../..');
const version = require('../../package.json').version;
const script = path.join(root, 'scripts/package_native.py');
const top = `aidm-api-${version}-windows-x64`;
let dir, api, engine, sums, out;

const makeArchives = `
import io, json, stat, sys, tarfile, zipfile
api, engine, fixture = sys.argv[1], sys.argv[2], json.load(sys.stdin)
with zipfile.ZipFile(api, 'w') as archive:
    for entry in fixture['api']:
        info = zipfile.ZipInfo(entry['name'])
        info.create_system = 3
        info.external_attr = entry.get('mode', stat.S_IFREG | 0o644) << 16
        archive.writestr(info, entry.get('data', '').encode())
with tarfile.open(engine, 'w:gz') as archive:
    for entry in fixture['engine']:
        info = tarfile.TarInfo(entry['name'])
        info.mode = entry.get('mode', 0o644)
        info.uid, info.gid, info.mtime = 1000, 1000, 123
        info.type = entry.get('type', '0').encode()
        info.linkname = entry.get('link', '')
        data = entry.get('data', '').encode()
        info.size = len(data) if info.isfile() else 0
        archive.addfile(info, io.BytesIO(data) if info.isfile() else None)
`;

function defaultFixture() {
    return {
        api: [
            { name: `${top}/`, mode: 0o40755 },
            { name: `${top}/aidm-api.exe`, data: 'API executable', mode: 0o100755 },
            { name: `${top}/helpers/odm_python.bat`, data: 'helper' },
            { name: `${top}/apps/7z/7za.exe`, data: '7-Zip' },
            ...['config-default.json', 'public/index.html', 'docs/swagger.json', 'tests/output.txt',
                'LICENSE', 'SOURCE', 'THIRD-PARTY-NOTICES.txt'].map(name => ({ name: `${top}/${name}`, data: name })),
            ...['tmp', 'data'].map(name => ({ name: `${top}/${name}/`, mode: 0o40755 }))
        ],
        engine: [
            { name: 'engine-release', type: '5', mode: 0o755 },
            { name: 'engine-release/engine/VERSION', data: '0.3.0\r\n' },
            { name: 'engine-release/engine/run.bat', data: 'run' },
            { name: 'engine-release/engine/win32env.bat', data: 'environment' },
            { name: 'engine-release/engine/python/python.exe', data: 'Python', mode: 0o755 }
        ]
    };
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function fixtures(change = () => {}) {
    const fixture = defaultFixture();
    change(fixture);
    const p = Bun.spawnSync(['python3', '-c', makeArchives, api, engine], { stdin: Buffer.from(JSON.stringify(fixture)) });
    expect(p.exitCode).toBe(0);
    const hash = sha256(engine);
    fs.writeFileSync(sums, `version 0.3.0\n${hash}  engine.tar.gz  windows-x64\n` +
        `${hash}  engine-cuda.tar.gz  windows-x64-cuda  576.57\n`);
}
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-native-'));
    api = path.join(dir, 'api.zip');
    engine = path.join(dir, 'engine.tar.gz');
    sums = path.join(dir, 'sums.txt');
    out = path.join(dir, 'out');
    fixtures();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(variant = 'windows-x64', extra = [], dest = out, mask = '022') {
    const p = Bun.spawnSync(['bash', '-c', 'umask "$1"; shift; exec "$@"', 'fixture', mask,
        'python3', script, variant, api, engine, dest, '--sums', sums, ...extra], {
        env: { ...process.env, SOURCE_DATE_EPOCH: '1234567890', PYTHONDONTWRITEBYTECODE: '1' }
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
function inspect(archive) {
    const p = Bun.spawnSync(['python3', '-c', `
import json, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    print(json.dumps([dict(name=m.name, uid=m.uid, gid=m.gid, mtime=m.mtime, mode=m.mode,
        data=archive.extractfile(m).read().decode() if m.isfile() else None) for m in archive]))
`, archive]);
    expect(p.exitCode).toBe(0);
    return JSON.parse(p.stdout.toString());
}

for (const variant of ['windows-x64', 'windows-x64-cuda']) {
    test(`${variant} has the API at the root, engine beneath it and a checked description`, () => {
        const r = run(variant);
        expect(r.code).toBe(0);
        const name = `aidm-native-${version}-${variant}`;
        const file = path.join(out, `${name}.tar.gz`);
        expect(r.out.trim()).toBe(file);
        expect(fs.readdirSync(out).sort()).toEqual([`${name}.json`, `${name}.tar.gz`]);
        expect(JSON.parse(fs.readFileSync(path.join(out, `${name}.json`), 'utf8'))).toEqual({
            name: `${name}.tar.gz`, size: fs.statSync(file).size, sha256: sha256(file)
        });
        const members = inspect(file);
        expect(members.map(m => m.name)).toEqual(members.map(m => m.name).sort());
        for (const member of members) {
            expect(member.name === name || member.name.startsWith(name + '/')).toBe(true);
            expect([member.uid, member.gid, member.mtime]).toEqual([0, 0, 1234567890]);
        }
        const files = Object.fromEntries(members.filter(m => m.data !== null).map(m => [m.name.slice(name.length + 1), m.data]));
        expect(files).toEqual(Object.fromEntries([
            ...defaultFixture().api.filter(e => !e.name.endsWith('/')).map(e => [e.name.slice(top.length + 1), e.data]),
            ...defaultFixture().engine.filter(e => !e.type).map(e => [e.name.slice('engine-release/'.length), e.data])
        ]));
        expect(members.find(m => m.name === `${name}/aidm-api.exe`).mode).toBe(0o755);
        expect(members.find(m => m.name === `${name}/tmp`).data).toBeNull();
        expect(members.find(m => m.name === `${name}/data`).data).toBeNull();
        expect(fs.readFileSync(file).readUInt32LE(4)).toBe(0); // gzip -n omits the clock.
    });
}

test('the same inputs yield identical bytes twice even under a different umask', () => {
    expect(run().code).toBe(0);
    const second = path.join(dir, 'second');
    expect(run('windows-x64', [], second, '077').code).toBe(0);
    for (const name of fs.readdirSync(out)) {
        expect(fs.readFileSync(path.join(out, name))).toEqual(fs.readFileSync(path.join(second, name)));
    }
});

for (const required of ['VERSION', 'run.bat', 'win32env.bat']) {
    test(`refuses an engine without ${required}`, () => {
        fixtures(f => { f.engine = f.engine.filter(e => !e.name.endsWith('/' + required)); });
        const r = run();
        expect(r.code).toBe(1);
        expect(r.err).toContain(`lacks engine/${required}`);
        expect(fs.readdirSync(out)).toEqual([]);
    });
}

for (const [name, mutate, message] of [
    ['wrong VERSION', f => { f.engine[1].data = '0.2.0'; }, 'pinned version is 0.3.0'],
    ['two engine top folders', f => { f.engine.push({ name: 'second/file', data: 'extra' }); }, 'exactly one top folder'],
    ['loose engine files', f => { f.engine = [{ name: 'VERSION', data: '0.3.0' }]; }, 'exactly one top folder'],
    ['no engine folder', f => { f.engine = [{ name: 'top/other', data: 'other' }]; }, 'lacks engine/VERSION'],
    ['empty engine archive', f => { f.engine = []; }, 'exactly one top folder'],
    ['two API top folders', f => { f.api.push({ name: 'other/file', data: 'extra' }); }, 'exactly one top folder'],
    ['wrong API version', f => { f.api = [{ name: 'old/aidm-api.exe', data: 'old' }]; }, "this version's Windows release folder"],
    ['API engine collision', f => { f.api.push({ name: `${top}/engine/file`, data: 'collision' }); }, 'already contain engine/'],
    ['engine traversal', f => { f.engine.push({ name: 'engine-release/../../escape', data: 'escape' }); }, 'Unsafe archive path'],
    ['API traversal', f => { f.api.push({ name: `${top}/../../escape`, data: 'escape' }); }, 'Unsafe archive path'],
    ['engine absolute path', f => { f.engine.push({ name: '/escape', data: 'escape' }); }, 'Unsafe archive path'],
    ['Windows API path', f => { f.api.push({ name: 'C:\\escape', data: 'escape' }); }, 'Unsafe archive path'],
    ['engine symlink', f => { f.engine.push({ name: 'engine-release/link', type: '2', link: '/tmp' }); }, 'links and special files'],
    ['engine hardlink', f => { f.engine.push({ name: 'engine-release/link', type: '1', link: 'engine-release/engine/VERSION' }); }, 'links and special files'],
    ['API symlink', f => { f.api.push({ name: `${top}/link`, mode: 0o120777, data: '/tmp' }); }, 'links and special files'],
    ['engine device', f => { f.engine.push({ name: 'engine-release/device', type: '3' }); }, 'links and special files'],
    ['duplicate engine file', f => { f.engine.push(f.engine[1]); }, 'Duplicate archive path']
]) {
    test(`refuses ${name} before publishing files`, () => {
        fixtures(mutate);
        const r = run();
        expect(r.code).toBe(1);
        expect(r.err).toContain(message);
        expect(fs.readdirSync(out)).toEqual([]);
        expect(fs.existsSync(path.join(dir, 'escape'))).toBe(false);
    });
}

test('checks the engine sum even when the layout is valid', () => {
    fs.appendFileSync(engine, 'changed');
    expect(run().err).toContain('SHA-256 mismatch');
    expect(fs.existsSync(out)).toBe(false);
});

test('reports the actual package size when it passes the release asset limit', () => {
    const r = run('windows-x64', ['--max-bytes', '1']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Native package is [1-9]\d* bytes, exceeding the release asset limit of 1 bytes/);
    expect(fs.readdirSync(out)).toEqual([]);
});

test('the release asset limit cannot be raised beyond 2 GiB', () => {
    const r = run('windows-x64', ['--max-bytes', String(2 * 1024 ** 3 + 1)]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Size limit must be between 1 and 2147483648 bytes');
});

test('a package exactly at the configured size limit passes, one byte over fails', () => {
    expect(run().code).toBe(0);
    const archive = path.join(out, `aidm-native-${version}-windows-x64.tar.gz`);
    const size = fs.statSync(archive).size;
    expect(run('windows-x64', ['--max-bytes', String(size)], path.join(dir, 'exact')).code).toBe(0);
    const r = run('windows-x64', ['--max-bytes', String(size - 1)], path.join(dir, 'over'));
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Native package is ${size} bytes`);
});
