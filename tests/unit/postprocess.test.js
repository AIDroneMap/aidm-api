const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, '..', '..', 'scripts', 'postprocess.sh');
const bash = Bun.which('bash');

function postprocess({ tools = {}, existing = false, input = true } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'postprocess-'));
    const project = path.join(directory, 'project');
    const bin = path.join(directory, 'bin');
    const callsFile = path.join(directory, 'calls');
    try {
        fs.mkdirSync(path.join(directory, 'scripts'));
        fs.mkdirSync(project);
        fs.mkdirSync(bin);
        fs.copyFileSync(script, path.join(directory, 'scripts', 'postprocess.sh'));
        for (const command of ['realpath', 'dirname', 'nproc', 'mkdir', 'rm']) {
            fs.symlinkSync(Bun.which(command), path.join(bin, command));
        }
        if (input) {
            fs.mkdirSync(path.join(project, 'odm_georeferencing'));
            fs.writeFileSync(path.join(project, 'odm_georeferencing', 'odm_georeferenced_model.laz'), '');
        }
        if (existing) {
            fs.mkdirSync(path.join(project, 'entwine_pointcloud'));
        }
        for (const [tool, outcome] of Object.entries(tools)) {
            const output = tool === 'PotreeConverter' ? 'potree_pointcloud' : 'entwine_pointcloud';
            fs.writeFileSync(path.join(bin, tool), `#!${bash}
printf '%s\\n' "${tool} $*" >> "$POSTPROCESS_CALLS"
if [ -e entwine_pointcloud-tmp ]; then
    exit 2
fi
mkdir -p entwine_pointcloud-tmp
${outcome !== 'fail' ? `mkdir -p ${output}` : ''}
exit ${outcome === 'success' ? '0' : '1'}
`, { mode: 0o755 });
        }
        const result = Bun.spawnSync([bash, path.join(directory, 'scripts', 'postprocess.sh'), 'project'], {
            env: { ...process.env, PATH: bin, POSTPROCESS_CALLS: callsFile }
        });
        return {
            code: result.exitCode,
            out: result.stdout.toString(),
            err: result.stderr.toString(),
            calls: fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n') : [],
            ept: fs.existsSync(path.join(project, 'entwine_pointcloud')),
            potree: fs.existsSync(path.join(project, 'potree_pointcloud')),
            temporary: fs.existsSync(path.join(project, 'entwine_pointcloud-tmp'))
        };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

for (const tools of [
    { entwine: 'success', untwine: 'success' },
    { entwine: 'success' },
    { untwine: 'success' },
    {}
]) {
    test(`reports existing EPT once with tools: ${Object.keys(tools).join(', ') || 'none'}`, () => {
        const result = postprocess({ tools, existing: true });
        expect(result.code).toBe(0);
        expect(result.out.match(/Entwine point cloud is already built\./g)).toHaveLength(1);
        expect(result.calls).toEqual([]);
        expect(result.ept).toBe(true);
        expect(result.err).toBe('');
    });
}

for (const [name, tools, expected] of [
    ['prefers entwine', { entwine: 'success', untwine: 'success' }, ['entwine']],
    ['uses entwine alone', { entwine: 'success' }, ['entwine']],
    ['uses untwine when entwine is missing', { untwine: 'success' }, ['untwine']],
    ['uses untwine when entwine fails', { entwine: 'fail', untwine: 'success' }, ['entwine', 'untwine']],
    ['uses untwine after a partial entwine failure', { entwine: 'partial', untwine: 'success' }, ['entwine', 'untwine']]
]) {
    test(name, () => {
        const result = postprocess({ tools });
        expect(result.code).toBe(0);
        expect(result.calls.map(call => call.split(' ')[0])).toEqual(expected);
        expect(result.ept).toBe(true);
        expect(result.temporary).toBe(false);
        expect(result.out).not.toContain('Entwine point cloud is already built.');
        expect(result.err).toBe('');
        if (expected.includes('entwine')) {
            expect(result.calls[0]).toMatch(/^entwine build --threads \d+ --tmp entwine_pointcloud-tmp -i odm_georeferencing\/odm_georeferenced_model.laz -o entwine_pointcloud$/);
        }
        if (expected.includes('untwine')) {
            expect(result.calls.at(-1)).toBe('untwine --temp_dir entwine_pointcloud-tmp --files odm_georeferencing/odm_georeferenced_model.laz --output_dir entwine_pointcloud');
        }
    });
}

test('uses PotreeConverter when neither EPT tool is installed', () => {
    const result = postprocess({ tools: { PotreeConverter: 'success' } });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual(['PotreeConverter odm_georeferencing/odm_georeferenced_model.laz -o potree_pointcloud --overwrite -a RGB CLASSIFICATION']);
    expect(result.potree).toBe(true);
});

test('continues when both EPT tools fail', () => {
    const result = postprocess({ tools: { entwine: 'fail', untwine: 'fail', PotreeConverter: 'success' } });
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.split(' ')[0])).toEqual(['entwine', 'untwine', 'PotreeConverter']);
    expect(result.ept).toBe(false);
    expect(result.potree).toBe(true);
    expect(result.out).toContain('Postprocessing: done');
});

test('continues when no point cloud tools are installed', () => {
    const result = postprocess();
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.out).toContain('PotreeConverter is not installed');
    expect(result.out).toContain('Postprocessing: done');
});

test('skips point cloud tools when no point cloud input exists', () => {
    const result = postprocess({ tools: { entwine: 'success', untwine: 'success' }, input: false });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.out).toContain('Point cloud tiles will not be generated');
});
