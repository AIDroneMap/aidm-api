// Checks that every file that states the API version says the version in
// package.json. A version bump that misses one fails here, with the file and
// the wrong value. History (older changelog entries, specs) is not checked.
const { test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const version = JSON.parse(read('package.json')).version;

function all(re) {
    return (text) => [...text.matchAll(re)].map((m) => m[1]);
}

// Each check returns the versions a file states. An empty list fails too, so
// a check cannot pass silently after the text it looks for has moved.
const checks = [
    { file: 'Dockerfile', what: 'image.version label', find: all(/org\.opencontainers\.image\.version="([^"]+)"/g) },
    { file: 'Dockerfile.gpu', what: 'image.version label', find: all(/org\.opencontainers\.image\.version="([^"]+)"/g) },
    { file: 'apptainer.def', what: 'image.version label', find: all(/org\.opencontainers\.image\.version\s+(\S+)/g) },
    { file: 'docs/swagger.json', what: 'info.version', find: (text) => [JSON.parse(text).info.version] },
    { file: 'docs/index.adoc', what: '_Version_ line', find: all(/^_Version_ : (\S+)$/gm) },
    {
        file: 'README.md',
        what: 'status line',
        // The line also names the engine version, so take only "Status: X"
        // and "AIDM API X"
        find: (text) => {
            const line = text.split('\n').find((l) => l.startsWith('> **Status:')) || '';
            return all(/(?:\*\*Status: |AIDM API )(\d+\.\d+\.\d+)/g)(line);
        }
    },
    { file: 'README.md', what: 'image tag', find: all(/ghcr\.io\/aidronemap\/aidm-api:(\d+\.\d+\.\d+)/g) },
    {
        file: 'CHANGELOG.md',
        what: 'newest version heading',
        find: (text) => {
            const m = text.match(/^## (\d+\.\d+\.\d+)\s*$/m);
            return m ? [m[1]] : [];
        }
    },
    { file: 'tests/compat/README.md', what: 'archive name', find: all(/aidm-api-(\d+\.\d+\.\d+)-linux-x64/g) }
];

test('package.json has a version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
});

for (const { file, what, find } of checks) {
    test(`${file} ${what} says ${version}`, () => {
        const found = find(read(file));
        const problems = found.length === 0
            ? [`${file}: no ${what} found`]
            : found.filter((v) => v !== version).map((v) => `${file}: ${what} says ${v}, package.json says ${version}`);
        expect(problems).toEqual([]);
    });
}
