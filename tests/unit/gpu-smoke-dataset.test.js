// Checks the dataset step of scripts/gpu-smoke-modal-api.py, the GPU test of
// the release workflow. The script loads the engine's gpu-smoke-modal.py from
// the engine release the image is built on, so it must call that module the
// way that release defines it. The stub below has the dataset helpers of
// engine 0.2.0: select_dataset(config, name) and
// fetch_dataset(dataset, cache, folder). Its fetch_dataset records the call
// and stops the script there, before it needs Modal.
const { test, expect, beforeAll, afterAll } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, '..', '..', 'scripts', 'gpu-smoke-modal-api.py');
const IMAGE = 'ghcr.io/aidronemap/aidm-api-ci@sha256:' + '0'.repeat(64);

const STUB = `
import json, os

DATASETS = ("ci", "full")

def log(msg):
    print("[gpu-smoke] %s" % msg, flush=True)

def env_required(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit("%s is not set" % name)
    return value

def read_config():
    return {
        "DEFAULT_OPTIONS": "--dsm",
        "OUTPUTS": "odm_orthophoto/odm_orthophoto.tif",
        "CI_DATASET_URL": "https://example.invalid/ci.zip",
        "CI_DATASET_SHA256": "c" * 64,
        "CI_DATASET_IMAGES": "32",
        "FULL_DATASET_URL": "https://example.invalid/full.zip",
        "FULL_DATASET_SHA256": "f" * 64,
        "FULL_DATASET_IMAGES": "73",
    }

def select_dataset(config, name):
    if name not in DATASETS:
        raise RuntimeError("SMOKE_DATASET is '%s', expected ci or full" % name)
    prefix = name.upper() + "_DATASET_"
    return {
        "url": config[prefix + "URL"],
        "sha256": config[prefix + "SHA256"],
        "images": int(config[prefix + "IMAGES"]),
    }

def fetch_dataset(dataset, cache, folder):
    with open(os.environ["STUB_RECORD"], "w") as f:
        json.dump({"dataset": dataset, "cache": cache, "folder": folder,
                   "folder_exists": os.path.isdir(folder)}, f)
    raise RuntimeError("stub: stopped before Modal")
`;

let dir;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-smoke-dataset-'));
    fs.mkdirSync(path.join(dir, 'engine'));
    fs.writeFileSync(path.join(dir, 'engine', 'gpu-smoke-modal.py'), STUB);
});

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function runScript(env = {}) {
    const record = path.join(dir, 'record.json');
    fs.rmSync(record, { force: true });
    const p = Bun.spawnSync(['python3', '-I', script, path.join(dir, 'engine'), IMAGE], {
        env: {
            PATH: process.env.PATH,
            HOME: dir,
            STUB_RECORD: record,
            MODAL_ENVIRONMENT: 'test',
            MODAL_TOKEN_ID: 'test',
            MODAL_TOKEN_SECRET: 'test',
            SMOKE_CACHE: path.join(dir, 'cache'),
            ...env
        }
    });
    const out = p.stdout.toString() + p.stderr.toString();
    const call = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null;
    return { code: p.exitCode, out, call };
}

test('fetches the ci dataset by default, into a folder of the run', () => {
    const { code, out, call } = runScript();
    expect(out).not.toContain('TypeError');
    expect(call).not.toBeNull();
    expect(call.dataset).toEqual({ url: 'https://example.invalid/ci.zip', sha256: 'c'.repeat(64), images: 32 });
    expect(call.cache).toBe(path.join(dir, 'cache'));
    expect(call.folder_exists).toBe(true);
    // A dataset error ends the run with one FAIL line, before Modal is needed
    expect(out).toContain('FAIL: stub: stopped before Modal');
    expect(out).not.toContain('Traceback');
    expect(code).toBe(1);
    // and the unpacked folder does not outlive the run
    expect(fs.existsSync(call.folder)).toBe(false);
});

test('SMOKE_DATASET=full fetches the full dataset', () => {
    const { call } = runScript({ SMOKE_DATASET: 'full' });
    expect(call).not.toBeNull();
    expect(call.dataset).toEqual({ url: 'https://example.invalid/full.zip', sha256: 'f'.repeat(64), images: 73 });
});

test('an unknown SMOKE_DATASET fails with the engine message', () => {
    const { code, out, call } = runScript({ SMOKE_DATASET: 'tiny' });
    expect(call).toBeNull();
    expect(out).toContain("FAIL: SMOKE_DATASET is 'tiny', expected ci or full");
    expect(out).not.toContain('Traceback');
    expect(code).toBe(1);
});
