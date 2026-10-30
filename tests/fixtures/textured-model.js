const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(bytes) {
    let checksum = 0xffffffff;
    for (const byte of bytes) {
        checksum ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
        }
    }
    return (checksum ^ 0xffffffff) >>> 0;
}

function pngChunk(type, bytes) {
    const name = Buffer.from(type);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
    return Buffer.concat([header, name, bytes, checksum]);
}

function createTexturedModel() {
    const imageHeader = Buffer.alloc(13);
    imageHeader.writeUInt32BE(2, 0);
    imageHeader.writeUInt32BE(2, 4);
    imageHeader[8] = 8;
    imageHeader[9] = 6;
    const pixels = Buffer.from([
        0, 255, 0, 0, 255, 0, 255, 0, 255,
        0, 0, 0, 255, 255, 255, 255, 0, 255
    ]);
    const image = Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        pngChunk('IHDR', imageHeader),
        pngChunk('IDAT', zlib.deflateSync(pixels, { level: 0 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
    const positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
    const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    const coordinates = [0, 0, 1, 0, 1, 1, 0, 1];
    const indices = [0, 1, 2, 0, 2, 3];
    const geometry = Buffer.alloc(140);
    [...positions, ...normals, ...coordinates].forEach((value, index) => geometry.writeFloatLE(value, index * 4));
    indices.forEach((value, index) => geometry.writeUInt16LE(value, 128 + index * 2));
    const binary = Buffer.concat([geometry, image]);
    const model = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
            indices: 3,
            material: 0,
            mode: 4
        }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
            { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
            { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' }
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: 48, target: 34962 },
            { buffer: 0, byteOffset: 48, byteLength: 48, target: 34962 },
            { buffer: 0, byteOffset: 96, byteLength: 32, target: 34962 },
            { buffer: 0, byteOffset: 128, byteLength: 12, target: 34963 },
            { buffer: 0, byteOffset: 140, byteLength: image.length }
        ],
        buffers: [{ byteLength: binary.length }],
        materials: [{ doubleSided: true, pbrMetallicRoughness: {
            baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1
        } }],
        textures: [{ sampler: 0, source: 0 }],
        samplers: [{ magFilter: 9728, minFilter: 9728 }],
        images: [{ bufferView: 4, mimeType: 'image/png' }]
    };
    const json = Buffer.from(JSON.stringify(model));
    const jsonPadding = Buffer.alloc((4 - json.length % 4) % 4, 0x20);
    const binaryPadding = Buffer.alloc((4 - binary.length % 4) % 4);
    const header = Buffer.alloc(12);
    header.write('glTF');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(28 + json.length + jsonPadding.length + binary.length + binaryPadding.length, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(json.length + jsonPadding.length, 0);
    jsonHeader.write('JSON', 4);
    const binaryHeader = Buffer.alloc(8);
    binaryHeader.writeUInt32LE(binary.length + binaryPadding.length, 0);
    binaryHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jsonHeader, json, jsonPadding, binaryHeader, binary, binaryPadding]);
}

module.exports = { createTexturedModel };

if (require.main === module) {
    fs.writeFileSync(path.join(__dirname, '..', 'processing_results', 'odm_texturing', 'odm_textured_model_geo.glb'), createTexturedModel());
}
