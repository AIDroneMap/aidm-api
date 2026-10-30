/* 
NodeODX App and REST API to access ODX. 
Copyright (C) 2026 NodeODX Contributors

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
const fs = require('fs');
const path = require('path');
const appRoot = require('./appRoot');

// Picks the programs that extract zip files and build all.zip.
//
// A release archive bundles one 7-Zip under apps/7z/ (scripts/package.sh):
// the static 7zzs on Linux, 7za.exe on Windows. A compiled executable uses it
// first, for both jobs, so an archive behaves the same on every machine.
// Without it, and always in source mode and in the images, the programs come
// from the PATH: libs/ziputils.js tries unzip, then 7z.
function lookup({ compiled, root, platform, exists = fs.existsSync }){
    if (compiled){
        const bundled = path.join(root, "apps", "7z", platform === "win32" ? "7za.exe" : "7zzs");
        if (exists(bundled)) return { sevenZ: bundled, unzip: "unzip", bundledSevenZ: true };
    }
    return { sevenZ: "7z", unzip: "unzip", bundledSevenZ: false };
}

module.exports = Object.assign(
    lookup({ compiled: appRoot.compiled, root: appRoot.root, platform: process.platform }),
    { lookup }
);
