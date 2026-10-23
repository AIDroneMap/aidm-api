// Records the JSON.parse error messages of the running JavaScript engine for a
// fixed set of invalid inputs. Run it with Node.js 14 to refresh the fixture:
//   node tests/unit/record-json-errors.js > tests/unit/json-errors-node14.json
"use strict";

const hand = ['', ' ', ' \n', '{not json', '{"uuid": ', '{', '[', '[1,]', '{"a":1,}', "{'a':1}", '[1 2]',
    '{"a" "b"}', '"abc', '"\\x"', '"a\nb"', '01', '-', '-a', '1.', '1.a', '1e', '1e+', 'tru', 'trux', 'tr1e',
    'nul"', '0x', '-0x', '0-', '-01', '"\\u12', '"\\u12x4"', '"\\u12"', '"\\1"', '{}x', '{} 1', '[1]]', 'nope',
    'undefined', 'NaN', '{"a":01}', '[-]', '[.5]', '"\\', '"\\u', '1 2', '{"a":1 "b":2}', '{,}', '[,]',
    '{"a"}', '{"a":}', '+1', '{"a":tru}', '[nulll]', 'falsey', '"\t"', '[1,2,3,', '{"a":[{"b":}]}',
    ' ', '" "', '00', '-00', '0.', '0e', '0.0.0', '1ee', '[0-1]', '"\\é"', 'é', '{"a":"\x01"}'];

// Random edits of valid JSON, with a fixed seed so the list is the same every run
const base = ['{"a":1,"b":[true,false,null],"c":"x\\ny\\u00e9"}', '[1,-2.5e+3,0,-0,0.1,1E5]',
    '{"uuid":"abc-123","options":[{"name":"x","value":3}]}', '"str\\"ing"', '[{"name":"orthophoto-resolution","value":5}]'];
const alphabet = ['{', '}', '[', ']', ':', ',', '"', '\\', '-', '+', '.', 'e', 'E', '0', '1', '9', 't', 'r',
    'u', 'f', 'a', 'l', 's', 'n', ' ', '\n', '\t', '\x01', 'x', '#', 'é', 'A', '/', 'b'];
let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = list => list[Math.floor(random() * list.length)];

const inputs = hand.slice();
while (inputs.length < 3000){
    let chars = pick(base).split('');
    for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits--){
        const op = random();
        const pos = Math.floor(random() * (chars.length + 1));
        if (op < 0.4) chars.splice(pos, 1);
        else if (op < 0.7) chars.splice(pos, 0, pick(alphabet));
        else if (op < 0.9) chars[pos] = pick(alphabet);
        else chars = chars.slice(0, pos);
    }
    inputs.push(chars.join(''));
}

const cases = [];
for (const input of inputs){
    try{
        JSON.parse(input);
    }catch(e){
        cases.push({ input, message: e.message });
    }
}

console.log(JSON.stringify({ recordedWith: `Node.js ${process.version}`, cases }, null, 1));
