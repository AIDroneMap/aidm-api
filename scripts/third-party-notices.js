#!/usr/bin/env bun
// Write THIRD-PARTY-NOTICES.txt for a compiled AIDM API executable.
//
// Usage: bun scripts/third-party-notices.js [--7zip <dir>] <outfile>
//
// Run "bun install --frozen-lockfile --production" first. The script lists
// the Bun runtime and every npm package in the production dependency tree,
// with licence texts. It has no dependencies.
//
// --7zip is the folder scripts/get-7zip.sh filled: the 7-Zip executable the
// archive bundles in apps/7z/, License.txt from its package and source.txt.
// The licence text is copied as it is, so the notices carry the exact text of
// the pinned package.
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const noticesDir = path.join(__dirname, "notices");
const LICENCE_FILE = /^(licen[cs]e|copying)/i;

function fail(message) {
    console.error("Error: " + message);
    process.exit(1);
}

function readText(file) {
    return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Find node_modules/<name> the way Node does: next to the requiring package,
// then in each parent folder up to the repository root.
function resolvePackage(name, fromDir) {
    let dir = fromDir;
    for (;;) {
        const candidate = path.join(dir, "node_modules", name);
        if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
        if (dir === root) return null;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function licenceField(pkg) {
    const names = [];
    const add = (value) => {
        if (typeof value === "string") names.push(value);
        else if (value && typeof value.type === "string") names.push(value.type);
    };
    add(pkg.license);
    if (Array.isArray(pkg.licenses)) pkg.licenses.forEach(add);
    else add(pkg.licenses);
    const unique = names.filter((n, i) => names.indexOf(n) === i);
    return unique.length ? unique.join(", ") : "not stated";
}

function repositoryUrl(pkg) {
    const repo = pkg.repository;
    if (typeof repo === "string") return repo;
    if (repo && typeof repo.url === "string") return repo.url;
    return null;
}

function licenceText(dir) {
    const files = fs
        .readdirSync(dir)
        .filter((f) => LICENCE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
        .sort();
    return files.length ? readText(path.join(dir, files[0])) : null;
}

// Walk the production dependency tree. Optional and peer dependencies are
// listed only if they are installed.
function collect() {
    const rootPkg = readJson(path.join(root, "package.json"));
    const found = new Map();
    const seenDirs = new Set();

    function visit(pkg, pkgDir, isRoot) {
        const required = Object.keys(pkg.dependencies || {});
        const optional = Object.keys(pkg.optionalDependencies || {}).concat(
            isRoot ? [] : Object.keys(pkg.peerDependencies || {})
        );
        const todo = required.map((n) => [n, true]).concat(optional.map((n) => [n, false]));
        for (const [name, mustExist] of todo) {
            const dir = resolvePackage(name, pkgDir);
            if (!dir) {
                if (mustExist) {
                    fail(
                        "cannot resolve " + name + " (required by " + pkg.name +
                        "). Run 'bun install --frozen-lockfile --production' first."
                    );
                }
                continue;
            }
            if (seenDirs.has(dir)) continue;
            seenDirs.add(dir);
            const depPkg = readJson(path.join(dir, "package.json"));
            const key = (depPkg.name || name) + "@" + depPkg.version;
            if (!found.has(key)) found.set(key, { name: depPkg.name || name, pkg: depPkg, dir });
            visit(depPkg, dir, false);
        }
    }

    visit(rootPkg, root, true);
    return [...found.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.pkg.version < b.pkg.version ? -1 : 1
    );
}

// The bundled 7-Zip, from the folder scripts/get-7zip.sh filled
function readSevenZip(dir) {
    const binary = ["7zzs", "7za.exe"].find((name) => fs.existsSync(path.join(dir, name)));
    if (!binary) fail("no 7zzs or 7za.exe in " + dir);
    for (const name of ["License.txt", "source.txt"]) {
        if (!fs.existsSync(path.join(dir, name))) fail("no " + name + " in " + dir);
    }
    const [packageUrl, sourceUrl] = readText(path.join(dir, "source.txt")).split("\n");
    return { binary, packageUrl, sourceUrl, licence: readText(path.join(dir, "License.txt")) };
}

function main() {
    const usage = "usage: bun scripts/third-party-notices.js [--7zip <dir>] <outfile>";
    const args = process.argv.slice(2);
    let sevenZip = null;
    if (args[0] === "--7zip") {
        if (args.length < 2) fail(usage);
        sevenZip = readSevenZip(args[1]);
        args.splice(0, 2);
    }
    const outfile = args[0];
    if (!outfile || args.length !== 1) fail(usage);

    const bunVersion = readText(path.join(root, ".bun-version")).trim();
    const rule = "=".repeat(78);
    const out = [];
    const section = (title) => out.push(rule, title, rule, "");

    out.push(
        "THIRD-PARTY NOTICES",
        "",
        "This executable is AIDM API, licensed under the GNU Affero General Public",
        "License v3.0. The source code is at https://github.com/AIDroneMap/aidm-api",
        "(see the LICENSE and SOURCE files). It is compiled with Bun " + bunVersion + ",",
        "so it contains the Bun runtime and the npm packages listed below.",
        ""
    );
    if (sevenZip) {
        out.push(
            "The archive also holds 7-Zip in apps/7z/" + sevenZip.binary + ". The API runs it to",
            "extract zip files and to build all.zip.",
            ""
        );
    }

    section("Bun " + bunVersion);
    out.push(readText(path.join(noticesDir, "bun-LICENSE.md")), "");

    section("Relinking JavaScriptCore");
    out.push(
        "JavaScriptCore is licensed under the LGPL and is statically linked into Bun.",
        "The executable is a Bun binary with the AIDM API code appended. To use a",
        "modified JavaScriptCore, build Bun from https://github.com/oven-sh/bun at tag",
        "bun-v" + bunVersion + " with your changes (see the relinking steps above). Then build",
        "AIDM API from its source at the same version with:",
        "",
        "    scripts/build.sh --bun-binary <your bun> <outfile>",
        ""
    );

    section("GNU Lesser General Public License, version 2.0");
    out.push(
        "JavaScriptCore and WebKit use LGPL 2.",
        "",
        readText(path.join(noticesDir, "LGPL-2.0.txt")),
        ""
    );
    section("GNU Lesser General Public License, version 2.1");
    out.push(
        "tinycc uses LGPL 2.1.",
        "",
        readText(path.join(noticesDir, "LGPL-2.1.txt")),
        ""
    );

    const packages = collect();
    let withoutLicence = 0;
    section("npm packages (" + packages.length + ")");
    for (const { pkg, dir, name } of packages) {
        const text = licenceText(dir);
        if (text === null) withoutLicence++;
        const repo = repositoryUrl(pkg);
        out.push(
            "-".repeat(78),
            name + "@" + pkg.version,
            "License: " + licenceField(pkg)
        );
        if (repo) out.push("Repository: " + repo);
        out.push("", text === null ? "No licence file in the package." : text, "");
    }

    if (sevenZip) {
        section("7-Zip");
        out.push(
            "apps/7z/" + sevenZip.binary + " is the official 7-Zip build from",
            sevenZip.packageUrl,
            "The 7-Zip source code of the same version is at",
            sevenZip.sourceUrl,
            "The text below is License.txt from that package. The GNU LGPL it names is",
            "the version 2.1 text above.",
            "",
            sevenZip.licence,
            ""
        );
    }

    fs.mkdirSync(path.dirname(path.resolve(outfile)), { recursive: true });
    fs.writeFileSync(outfile, out.join("\n") + "\n");
    console.log(
        "Wrote " + outfile + ": " + packages.length + " packages listed, " +
        withoutLicence + " without a licence file."
    );
}

main();
