// Checks how libs/ziputils.js picks a zip tool. The config and the process
// runner are replaced, so the test needs neither unzip nor 7z.
const { test, expect, mock, beforeEach } = require('bun:test');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const configPath = path.join(root, 'config.js');
const processRunnerPath = path.join(root, 'libs', 'processRunner.js');
const ziputilsPath = path.join(root, 'libs', 'ziputils.js');

const calls = { unzip: [], sevenUnzip: [] };

beforeEach(() => {
    calls.unzip.length = 0;
    calls.sevenUnzip.length = 0;
});

// Bun copies the object a mock returns, so each test sets its own config and
// loads a fresh ziputils. The mocks are in place before the module loads.
function loadZiputils(config) {
    mock.module(configPath, () => config);
    mock.module(processRunnerPath, () => ({
        unzip: (options, cb) => {
            calls.unzip.push(options);
            cb(null, 0, '');
        },
        sevenUnzip: (options, cb) => {
            calls.sevenUnzip.push(options);
            cb(null, 0, '');
        }
    }));
    delete require.cache[ziputilsPath];
    return require(ziputilsPath);
}

test('fails with a clear error when neither unzip nor 7z is installed', () => {
    const ziputils = loadZiputils({ hasUnzip: false, has7z: false });
    const results = [];
    ziputils.unzip('images.zip', 'out', (...args) => results.push(args));

    expect(results.length).toBe(1);
    expect(results[0].length).toBe(1);
    expect(results[0][0]).toBeInstanceOf(Error);
    expect(results[0][0].message).toBe('Could not extract .zip file, neither unzip nor 7z is installed');
    expect(calls.unzip.length).toBe(0);
    expect(calls.sevenUnzip.length).toBe(0);
});

test('runs unzip when it is installed', () => {
    const ziputils = loadZiputils({ hasUnzip: true, has7z: true });
    const results = [];
    ziputils.unzip('images.zip', 'out', (...args) => results.push(args), true);

    expect(calls.unzip).toEqual([{ file: 'images.zip', destination: 'out', noDirectories: true }]);
    expect(calls.sevenUnzip.length).toBe(0);
    expect(results).toEqual([[]]);
});

test('runs 7z when only 7z is installed', () => {
    const ziputils = loadZiputils({ hasUnzip: false, has7z: true });
    const results = [];
    ziputils.unzip('images.zip', 'out', (...args) => results.push(args));

    expect(calls.sevenUnzip).toEqual([{ file: 'images.zip', destination: 'out', noDirectories: false }]);
    expect(calls.unzip.length).toBe(0);
    expect(results).toEqual([[]]);
});

// config.sevenZFirst: a release archive with its bundled 7-Zip (libs/apps.js)
test('runs the bundled 7z before unzip', () => {
    const ziputils = loadZiputils({ hasUnzip: true, has7z: true, sevenZFirst: true });
    const results = [];
    ziputils.unzip('images.zip', 'out', (...args) => results.push(args), true);

    expect(calls.sevenUnzip).toEqual([{ file: 'images.zip', destination: 'out', noDirectories: true }]);
    expect(calls.unzip.length).toBe(0);
    expect(results).toEqual([[]]);
});

test('runs unzip when the bundled 7z does not start', () => {
    const ziputils = loadZiputils({ hasUnzip: true, has7z: false, sevenZFirst: false });
    const results = [];
    ziputils.unzip('images.zip', 'out', (...args) => results.push(args));

    expect(calls.unzip).toEqual([{ file: 'images.zip', destination: 'out', noDirectories: false }]);
    expect(calls.sevenUnzip.length).toBe(0);
    expect(results).toEqual([[]]);
});
