const { test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createTexturedModel } = require('../fixtures/textured-model');

const fixture = fs.readFileSync(path.join(__dirname, '..', 'processing_results', 'odm_texturing', 'odm_textured_model_geo.glb'));

function readModel() {
    expect(fixture.length).toBeGreaterThanOrEqual(28);
    expect(fixture.toString('ascii', 0, 4)).toBe('glTF');
    expect(fixture.readUInt32LE(4)).toBe(2);
    expect(fixture.readUInt32LE(8)).toBe(fixture.length);
    const chunks = [];
    let offset = 12;
    while (offset < fixture.length) {
        expect(offset + 8).toBeLessThanOrEqual(fixture.length);
        const length = fixture.readUInt32LE(offset);
        expect(length % 4).toBe(0);
        expect(offset + 8 + length).toBeLessThanOrEqual(fixture.length);
        chunks.push({ type: fixture.readUInt32LE(offset + 4), bytes: fixture.subarray(offset + 8, offset + 8 + length) });
        offset += 8 + length;
    }
    expect(offset).toBe(fixture.length);
    expect(chunks.map(chunk => chunk.type)).toEqual([0x4e4f534a, 0x004e4942]);
    return { model: JSON.parse(chunks[0].bytes.toString()), binary: chunks[1].bytes };
}

function readAccessor(model, binary, index, components, componentType) {
    const accessor = model.accessors[index];
    expect(accessor.componentType).toBe(componentType);
    expect(accessor.type).toBe(components === 3 ? 'VEC3' : components === 2 ? 'VEC2' : 'SCALAR');
    const view = model.bufferViews[accessor.bufferView];
    const width = componentType === 5126 ? 4 : 2;
    const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
    expect(accessor.count * components * width).toBe(view.byteLength);
    return Array.from({ length: accessor.count }, (_, element) =>
        Array.from({ length: components }, (_, component) => {
            const offset = start + (element * components + component) * width;
            return componentType === 5126 ? binary.readFloatLE(offset) : binary.readUInt16LE(offset);
        }));
}

test('model fixture is a reproducible GLB 2 with a complete embedded scene', () => {
    const { model, binary } = readModel();
    expect(fixture.equals(createTexturedModel())).toBe(true);
    expect(model.asset.version).toBe('2.0');
    expect(model.scenes[model.scene].nodes).toEqual([0]);
    expect(model.nodes[0].mesh).toBe(0);
    expect(model.buffers).toHaveLength(1);
    expect(model.buffers[0].uri).toBeUndefined();
    expect(binary.length - model.buffers[0].byteLength).toBeGreaterThanOrEqual(0);
    expect(binary.length - model.buffers[0].byteLength).toBeLessThan(4);
    for (const view of model.bufferViews) {
        expect(view.buffer).toBe(0);
        expect(view.byteOffset % 4).toBe(0);
        expect(view.byteLength).toBeGreaterThan(0);
        expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(model.buffers[0].byteLength);
    }
    expect(model.extensionsRequired).toBeUndefined();
});

test('model fixture has finite textured triangles with nonzero area', () => {
    const { model, binary } = readModel();
    const primitive = model.meshes[0].primitives[0];
    expect(primitive.mode).toBe(4);
    const positions = readAccessor(model, binary, primitive.attributes.POSITION, 3, 5126);
    const normals = readAccessor(model, binary, primitive.attributes.NORMAL, 3, 5126);
    const coordinates = readAccessor(model, binary, primitive.attributes.TEXCOORD_0, 2, 5126);
    const indices = readAccessor(model, binary, primitive.indices, 1, 5123).flat();
    expect(positions).toHaveLength(4);
    expect(normals).toHaveLength(positions.length);
    expect(coordinates).toHaveLength(positions.length);
    expect(positions.flat().every(Number.isFinite)).toBe(true);
    expect(normals.every(normal => Math.hypot(...normal) === 1)).toBe(true);
    expect(coordinates.flat().every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    const accessor = model.accessors[primitive.attributes.POSITION];
    expect(accessor.min).toEqual([0, 1, 2].map(axis => Math.min(...positions.map(vertex => vertex[axis]))));
    expect(accessor.max).toEqual([0, 1, 2].map(axis => Math.max(...positions.map(vertex => vertex[axis]))));
    expect(indices).toHaveLength(6);
    for (let offset = 0; offset < indices.length; offset += 3) {
        const vertices = indices.slice(offset, offset + 3).map(index => {
            expect(index).toBeLessThan(positions.length);
            return positions[index];
        });
        const edge = vertices[1].map((value, axis) => value - vertices[0][axis]);
        const other = vertices[2].map((value, axis) => value - vertices[0][axis]);
        expect(Math.hypot(
            edge[1] * other[2] - edge[2] * other[1],
            edge[2] * other[0] - edge[0] * other[2],
            edge[0] * other[1] - edge[1] * other[0]
        )).toBeGreaterThan(0);
    }
});

test('model material references a self-contained synthetic PNG texture', () => {
    const { model, binary } = readModel();
    const primitive = model.meshes[0].primitives[0];
    const material = model.materials[primitive.material];
    const texture = model.textures[material.pbrMetallicRoughness.baseColorTexture.index];
    expect(model.samplers[texture.sampler]).toEqual({ magFilter: 9728, minFilter: 9728 });
    const image = model.images[texture.source];
    expect(model.images).toHaveLength(1);
    expect(image.uri).toBeUndefined();
    expect(image.mimeType).toBe('image/png');
    const view = model.bufferViews[image.bufferView];
    const png = binary.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    let offset = 8;
    const chunks = [];
    while (offset < png.length) {
        const length = png.readUInt32BE(offset);
        expect(offset + 12 + length).toBeLessThanOrEqual(png.length);
        chunks.push({ type: png.toString('ascii', offset + 4, offset + 8), bytes: png.subarray(offset + 8, offset + 8 + length) });
        offset += length + 12;
    }
    expect(offset).toBe(png.length);
    expect(chunks.map(chunk => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks[0].bytes.toString('hex')).toBe('00000002000000020806000000');
    expect(zlib.inflateSync(chunks[1].bytes)).toEqual(Buffer.from([
        0, 255, 0, 0, 255, 0, 255, 0, 255,
        0, 0, 0, 255, 255, 255, 255, 0, 255
    ]));
});
