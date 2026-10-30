const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const modelPath = 'odm_texturing/odm_textured_model_geo.glb';

function modelBytes() {
    return fs.readFileSync(path.join(__dirname, '..', 'processing_results', modelPath));
}

function checkModelEntry(archive, centralOffset) {
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    assert.strictEqual(archive.readUInt32LE(localOffset), 0x04034b50, 'Model ZIP entry needs a local header');
    const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const size = archive.readUInt32LE(centralOffset + 20);
    assert(start + size <= archive.length, 'Model ZIP entry is truncated');
    const compressed = archive.subarray(start, start + size);
    const method = archive.readUInt16LE(centralOffset + 10);
    assert(method === 0 || method === 8, 'Model ZIP entry uses an unsupported compression method');
    const bytes = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    assert.strictEqual(bytes.length, archive.readUInt32LE(centralOffset + 24), 'Model ZIP entry size differs');
    assert(bytes.equals(modelBytes()), 'Archived GLB differs from the model fixture');
}

function updateModelSize(expected) {
    const entry = modelPath + ' ' + modelBytes().length;
    for (const step of expected) {
        const zip = step.response && step.response.body && step.response.body.zip;
        if (zip) zip.entries = zip.entries.map(name => name.startsWith(modelPath + ' ') ? entry : name);
    }
}

module.exports = { modelPath, checkModelEntry, updateModelSize };
