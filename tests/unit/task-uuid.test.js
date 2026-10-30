const { test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const uuidv4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fixture = path.join(__dirname, 'fixtures', 'task-uuid.js');

function assignUUID(options = {}) {
    const result = Bun.spawnSync([process.execPath, fixture, JSON.stringify(options)]);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
}

test('uuid is not a direct dependency', () => {
    const root = path.join(__dirname, '..', '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.dependencies).not.toHaveProperty('uuid');
    expect(manifest.devDependencies).not.toHaveProperty('uuid');
});

test('generates task IDs with crypto.randomUUID()', () => {
    const generatedId = '01234567-89ab-4cde-8fab-0123456789ab';
    const result = assignUUID({ generatedId });
    expect(result.generatedCalls).toBe(1);
    expect(result.assignments).toEqual([{ id: generatedId, nextCalls: 1, errors: [] }]);
});

test('generates UUIDv4 task IDs when set-uuid is absent or empty', () => {
    for (const options of [{}, { suppliedIds: [''] }]) {
        const result = assignUUID(options);
        const [assignment] = result.assignments;
        expect(assignment.id).toMatch(uuidv4);
        expect(assignment.nextCalls).toBe(1);
        expect(assignment.errors).toEqual([]);
        expect(result.lookups).toEqual([]);
    }
});

test('generates distinct UUIDv4 task IDs across repeated requests', () => {
    const ids = new Set();
    const result = assignUUID({ count: 1024 });
    expect(result.assignments.length).toBe(1024);
    for (const assignment of result.assignments) {
        expect(assignment.id).toMatch(uuidv4);
        expect(assignment.nextCalls).toBe(1);
        expect(assignment.errors).toEqual([]);
        ids.add(assignment.id);
    }
    expect(ids.size).toBe(1024);
});

test('preserves supplied UUID versions, variants and letter case', () => {
    const suppliedIds = [];
    for (const version of ['1', '2', '3', '4', '5', '6', '7']) {
        for (const variant of ['8', '9', 'a', 'b']) {
            suppliedIds.push(`ABCDEF01-2345-${version}ABC-${variant}DEF-0123456789AB`);
        }
    }
    const result = assignUUID({ suppliedIds });
    expect(result.assignments).toEqual(suppliedIds.map(id => ({ id, nextCalls: 1, errors: [] })));
    expect(result.lookups).toEqual(suppliedIds);
    expect(result.generatedCalls).toBe(0);
});

test('rejects a supplied ID already used by a task', () => {
    const suppliedId = 'abcdef01-2345-4abc-8def-0123456789ab';
    const result = assignUUID({ suppliedIds: [suppliedId], existingId: suppliedId });
    expect(result.lookups).toEqual([suppliedId]);
    expect(result.assignments).toEqual([{ nextCalls: 0, errors: [{ error: `Invalid set-uuid: ${suppliedId}` }] }]);
    expect(result.generatedCalls).toBe(0);
});

for (const suppliedId of [
    'not-a-uuid',
    '../abcdef01-2345-4abc-8def-0123456789ab',
    'abcdef01-2345-0abc-8def-0123456789ab',
    'abcdef01-2345-8abc-8def-0123456789ab',
    'abcdef01-2345-4abc-7def-0123456789ab',
    'abcdef01-2345-4abc-cdef-0123456789ab',
    'abcdef01-2345-4abc-8def-0123456789ag',
    'abcdef01-2345-4abc-8def-0123456789a',
    'abcdef01-2345-4abc-8def-0123456789ab0',
    ' abcdef01-2345-4abc-8def-0123456789ab'
]) {
    test(`rejects invalid supplied ID ${JSON.stringify(suppliedId)}`, () => {
        const result = assignUUID({ suppliedIds: [suppliedId] });
        expect(result.assignments).toEqual([{ nextCalls: 0, errors: [{ error: `Invalid set-uuid: ${suppliedId}` }] }]);
        expect(result.lookups).toEqual([]);
        expect(result.generatedCalls).toBe(0);
    });
}
