// Checks that libs/jsonErrors.js words invalid-JSON errors exactly as
// Node.js 14 does. Run with: bun test tests/unit
"use strict";

const { test, expect } = require("bun:test");
const jsonErrors = require("../../libs/jsonErrors");
const fixture = require("./json-errors-node14.json");

test("fixture was recorded with Node.js 14", () => {
    expect(fixture.recordedWith).toStartWith("Node.js v14.");
    expect(fixture.cases.length).toBeGreaterThan(1000);
});

test("message() matches Node.js 14 for every recorded input", () => {
    const mismatches = fixture.cases
        .filter(c => jsonErrors.message(c.input) !== c.message)
        .map(c => ({ input: c.input, expected: c.message, actual: jsonErrors.message(c.input) }));
    expect(mismatches).toEqual([]);
});

test("message() returns null for valid JSON", () => {
    for (const text of ['{}', '[]', ' {"a":[1,-2.5e+3,true,false,null,"x\\u00e9"]} ', '0', '-0.5E-3', '"\\/"']){
        expect(jsonErrors.message(text)).toBeNull();
    }
});

test("parse() returns the value, or throws a SyntaxError with the Node.js 14 message", () => {
    expect(jsonErrors.parse('{"a":[1]}')).toEqual({ a: [1] });
    expect(() => jsonErrors.parse("{not json")).toThrow(new SyntaxError("Unexpected token n in JSON at position 1"));
});

test("bodyParserMessage() matches body-parser on Node.js 14", () => {
    // Recorded with body-parser 1.20 on Node.js 14.21.3
    expect(jsonErrors.bodyParserMessage('{"uuid": ')).toBe("Unexpected end of JSON input");
    expect(jsonErrors.bodyParserMessage('"abc"')).toBe("Unexpected token \" in JSON at position 0");
    expect(jsonErrors.bodyParserMessage("  123")).toBe("Unexpected token 1 in JSON at position 2");
    expect(jsonErrors.bodyParserMessage(" \n")).toBe("Unexpected end of JSON input");
    expect(jsonErrors.bodyParserMessage('{"a":1,}')).toBe("Unexpected token } in JSON at position 7");
    expect(jsonErrors.bodyParserMessage("  [1 2]")).toBe("Unexpected number in JSON at position 5");
});
