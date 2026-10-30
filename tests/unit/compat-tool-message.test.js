// Checks the one message the compatibility harness treats as equal to the
// golden file: the corrupt-zip error of the bundled 7-Zip, in the zipurl 404
// step of zip-input (ADR 0003). Every other text must still differ.
const { test, expect } = require('bun:test');

const { sameToolMessage } = require('../compat/run.js');

const UNZIP = 'Could not extract .zip file, unzip exited with code 9';
const SEVEN_Z = 'Could not extract .zip file, 7z exited with code 2';

function entry(step, errorMessage) {
    return {
        step,
        request: { method: 'GET', path: '/task/<uuid-3>/info' },
        response: { status: 200, body: { uuid: '<uuid-3>', status: { code: 30, errorMessage } } }
    };
}

test('the 7z message of the zipurl 404 step reads as the unzip one', () => {
    const entries = [entry('info of zipurl 404', SEVEN_Z)];
    sameToolMessage('zip-input', entries);
    expect(entries).toEqual([entry('info of zipurl 404', UNZIP)]);
});

test('the unzip message stays as it is', () => {
    const entries = [entry('info of zipurl 404', UNZIP)];
    sameToolMessage('zip-input', entries);
    expect(entries).toEqual([entry('info of zipurl 404', UNZIP)]);
});

test('other steps, scenarios and messages are not touched', () => {
    const entries = [
        entry('info of zipurl success', SEVEN_Z),
        entry('info of zipurl 404', 'Could not extract .zip file, 7z exited with code 7'),
        entry('info of zipurl 404', 'Could not extract .zip file, unzip exited with code 2')
    ];
    const copy = JSON.parse(JSON.stringify(entries));
    sameToolMessage('zip-input', entries);
    expect(entries).toEqual(copy);

    const other = [entry('info of zipurl 404', SEVEN_Z)];
    sameToolMessage('zip-input-no-tools', other);
    expect(other).toEqual([entry('info of zipurl 404', SEVEN_Z)]);
});
