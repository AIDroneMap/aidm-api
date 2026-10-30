const { test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { modelPath, checkModelEntry, updateModelSize } = require('../compat/model-fixture');

const fixture = fs.readFileSync(path.join(__dirname, '..', 'processing_results', modelPath));

function archiveEntry(bytes, method) {
    const compressed = method === 8 ? zlib.deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    const central = Buffer.alloc(46);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt32LE(0, 42);
    return { archive: Buffer.concat([local, compressed, central]), centralOffset: local.length + compressed.length };
}

for (const method of [0, 8]) {
    test(`archive check accepts unchanged model bytes with compression method ${method}`, () => {
        const { archive, centralOffset } = archiveEntry(fixture, method);
        expect(() => checkModelEntry(archive, centralOffset)).not.toThrow();
    });

    test(`archive check rejects same-size model corruption with compression method ${method}`, () => {
        const changed = Buffer.from(fixture);
        changed[changed.length - 1] ^= 1;
        const { archive, centralOffset } = archiveEntry(changed, method);
        expect(() => checkModelEntry(archive, centralOffset)).toThrow('Archived GLB differs from the model fixture');
    });
}

test('golden size adjustment changes only the GLB member size', () => {
    const expected = [{ response: { body: { zip: { count: 3, entries: [
        modelPath + ' 5', 'odm_texturing/', 'odm_texturing/other.glb 5'
    ] } } } }, { response: { body: { status: 40 } } }];
    updateModelSize(expected);
    expect(expected).toEqual([{ response: { body: { zip: { count: 3, entries: [
        modelPath + ' ' + fixture.length, 'odm_texturing/', 'odm_texturing/other.glb 5'
    ] } } } }, { response: { body: { status: 40 } } }]);
});
