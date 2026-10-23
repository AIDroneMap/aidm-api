/*
AIDM API, the REST task API of the AIDM photogrammetry engine.
Copyright (C) 2026 AIDM API Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
"use strict";

// Error messages for invalid JSON, worded exactly as Node.js 14 words them.
//
// Clients see these messages: an invalid "options" field on /task/new, or an
// invalid JSON body on /task/cancel, /task/remove or /task/restart, returns
// {"error": <message>}. The message comes from the JavaScript engine. Node.js
// 14 (V8 8.4) says "Unexpected token n in JSON at position 1", Bun
// (JavaScriptCore) says "JSON Parse error: Expected '}'". To keep the API
// unchanged, the API builds the message itself with the rules V8 8.4 uses.
//
// The scanner below follows V8 8.4's JsonParser (src/json/json-parser.cc): it
// stops at the same character and picks the same wording. It only finds the
// error; JSON.parse still does the parsing. tests/unit/jsonErrors.test.js
// checks it against messages recorded with Node.js 14.21.3.

const EOS = "eos";

// Token of a character, as in V8's one_char_json_tokens table
function tokenAt(text, pos){
    if (pos >= text.length) return EOS;
    const c = text[pos];
    if (c === '"') return "string";
    if (c === '-' || (c >= '0' && c <= '9')) return "number";
    return "other";
}

function messageAt(text, pos){
    switch (tokenAt(text, pos)){
        case EOS: return "Unexpected end of JSON input";
        case "number": return `Unexpected number in JSON at position ${pos}`;
        case "string": return `Unexpected string in JSON at position ${pos}`;
        default: return `Unexpected token ${text[pos]} in JSON at position ${pos}`;
    }
}

class Fail{
    constructor(message){
        this.message = message;
    }
}

const failAt = (text, pos) => new Fail(messageAt(text, pos));
const isDigit = c => c !== undefined && c >= '0' && c <= '9';
const isHex = c => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isWhitespace = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isNumberPart = c => isDigit(c) || c === '.' || c === 'e' || c === 'E' || c === '+' || c === '-';

function skipWhitespace(text, i){
    while (i < text.length && isWhitespace(text[i])) i++;
    return i;
}

// Returns the index after the string that starts at text[i] === '"'
function scanString(text, i){
    i++;
    for (;;){
        if (i >= text.length) throw new Fail(messageAt(text, i));
        const c = text[i];
        if (c === '"') return i + 1;
        if (c === '\\'){
            i++;
            const e = text[i];
            if (e === 'u'){
                for (let k = 0; k < 4; k++){
                    i++;
                    if (!isHex(text[i])) throw failAt(text, i);
                }
                i++;
            }else if (e !== undefined && '"\\/bfnrt'.indexOf(e) !== -1){
                i++;
            }else{
                throw failAt(text, i);
            }
        }else if (c.charCodeAt(0) < 0x20){
            throw failAt(text, i);
        }else{
            i++;
        }
    }
}

// Returns the index after the number that starts at text[i]
function scanNumber(text, i){
    let negative = false;
    if (text[i] === '-'){
        negative = true;
        i++;
    }

    if (text[i] === '0'){
        i++;
        if (isNumberPart(text[i])){
            if (isDigit(text[i])) throw new Fail(`Unexpected number in JSON at position ${i}`);
        }else if (!negative){
            return i;
        }
    }else{
        const start = i;
        while (isDigit(text[i])) i++;
        if (i === start) throw failAt(text, i);
    }

    if (text[i] === '.'){
        i++;
        if (!isDigit(text[i])) throw failAt(text, i);
        while (isDigit(text[i])) i++;
    }

    if (text[i] === 'e' || text[i] === 'E'){
        i++;
        if (text[i] === '-' || text[i] === '+') i++;
        if (!isDigit(text[i])) throw failAt(text, i);
        while (isDigit(text[i])) i++;
    }

    return i;
}

// Returns the index after "true", "false" or "null" starting at text[i]
function scanLiteral(text, i, word){
    for (let k = 1; k < word.length; k++){
        if (text[i + k] !== word[k]) throw failAt(text, i + k);
    }
    return i + word.length;
}

// Returns the index after the value that starts at or after text[i]
function scanValue(text, i){
    i = skipWhitespace(text, i);
    const c = text[i];

    if (c === '"') return scanString(text, i);
    if (c === '-' || isDigit(c)) return scanNumber(text, i);
    if (c === 't') return scanLiteral(text, i, "true");
    if (c === 'f') return scanLiteral(text, i, "false");
    if (c === 'n') return scanLiteral(text, i, "null");

    if (c === '{'){
        i = skipWhitespace(text, i + 1);
        if (text[i] === '}') return i + 1;
        for (;;){
            i = skipWhitespace(text, i);
            if (text[i] !== '"') throw failAt(text, i);
            i = skipWhitespace(text, scanString(text, i));
            if (text[i] !== ':') throw failAt(text, i);
            i = skipWhitespace(text, scanValue(text, i + 1));
            if (text[i] === ',') i++;
            else if (text[i] === '}') return i + 1;
            else throw failAt(text, i);
        }
    }

    if (c === '['){
        i = skipWhitespace(text, i + 1);
        if (text[i] === ']') return i + 1;
        for (;;){
            i = skipWhitespace(text, scanValue(text, i));
            if (text[i] === ',') i++;
            else if (text[i] === ']') return i + 1;
            else throw failAt(text, i);
        }
    }

    throw failAt(text, i);
}

// The message Node.js 14 gives for JSON.parse(text), or null if text is valid JSON
function message(text){
    text = String(text);
    try{
        const end = skipWhitespace(text, scanValue(text, 0));
        if (end < text.length) return messageAt(text, end);
        return null;
    }catch(e){
        if (e instanceof Fail) return e.message;
        throw e;
    }
}

// JSON.parse, with Node.js 14's error message when text is not valid JSON
function parse(text){
    try{
        return JSON.parse(text);
    }catch(e){
        if (e instanceof SyntaxError){
            const m = message(text);
            if (m !== null) e.message = m;
        }
        throw e;
    }
}

// The message body-parser 1.x gives on Node.js 14 for an invalid JSON body.
// In strict mode (the default) it rejects a body that does not start with
// "{" or "[" by parsing a copy where that part is replaced with "#".
function bodyParserMessage(body){
    const match = /^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d])/.exec(body);
    if (!match) return message("");
    const first = match[1];
    if (first !== '{' && first !== '['){
        const index = body.indexOf(first);
        return `Unexpected token ${first} in JSON at position ${index}`;
    }
    return message(body);
}

module.exports = {
    message,
    parse,
    bodyParserMessage
};
