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

// Finds the folder that holds the read-only resource files: config-default.json,
// public/, docs/, helpers/, scripts/, tests/ and apps/.
//
// In an executable built with `bun build --compile`, __dirname is the build
// machine's source folder, written into the binary at build time. So when
// compiled, use the folder of the executable instead. Otherwise use the
// repository root.
//
// Folders the API writes to (data/, tmp/) stay relative to the working
// directory, as before.

const path = require('path');

const compiled = typeof Bun !== "undefined" && Bun.isStandaloneExecutable === true;
const root = compiled ? path.dirname(process.execPath) : path.resolve(__dirname, "..");

module.exports = {
    compiled,
    root,

    // Absolute path of a resource, e.g. resolve("helpers", "odmOptionsToJson.py")
    resolve: (...parts) => path.join(root, ...parts)
};
