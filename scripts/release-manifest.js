#!/usr/bin/env bun
// Build, sign and verify the release manifest.
//
// Usage:
//   bun scripts/release-manifest.js build --engine-version <version> --image <image> --digests <folder> --out <file>
//       [--version <version>] [--package <package.json>]
//   bun scripts/release-manifest.js sign --manifest <file> --out <file> < private-key.pem
//   bun scripts/release-manifest.js verify --manifest <file> --signature <file> --public-key <file>
//
// build writes the release manifest, the JSON file aidm-ui reads. <image> is
// the image name without a tag. <folder> holds the digest files the build
// jobs write: cpu-amd64, cpu-arm64 and gpu-amd64, each one line, sha256:...
// Each variant's size is read from the registry with
// "docker buildx imagetools inspect <image>@<digest> --raw", as the sum of
// the compressed layer sizes and the config size. --version defaults to the
// version in package.json. minimumUiVersion always comes from package.json.
// The file is written once, with fixed key order and formatting, and the
// signature covers exactly those bytes.
//
// sign reads a PKCS#8 PEM Ed25519 private key on standard input and writes
// the raw 64-byte signature to --out.
//
// verify reads a public key file with one base64 line, the 32 raw key bytes,
// and exits 1 when the signature does not match the manifest.
//
// To make a throwaway key pair, for example in a dry run:
//   openssl genpkey -algorithm ed25519 -out key.pem
//   openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64 > public-key.txt
//
// Signing and verification use WebCrypto. The script has no dependencies.
"use strict";

const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;

// Digest file name, manifest variant id, and whether the image needs a GPU.
// The order is the order of the variants in the manifest.
const VARIANTS = [
    { file: "cpu-amd64", id: "linux-amd64-cpu", gpu: false },
    { file: "cpu-arm64", id: "linux-arm64-cpu", gpu: false },
    { file: "gpu-amd64", id: "linux-amd64-gpu", gpu: true }
];

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// The same rule aidm-ui applies: host, then path parts, no tag, no digest, and
// a first character that can never read as a command-line flag.
const IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

function fail(message) {
    throw new Error(message);
}

function parseVersion(version, what) {
    const m = VERSION.exec(typeof version === "string" ? version : "");
    if (!m) fail(`${what} "${version}" is not a version like 2.7.0`);
    return m.slice(1).map(Number);
}

// major x 1,000,000 + minor x 1,000 + patch. 2.7.0 is 2007000. A minor or
// patch of 1000 or more would overlap the next place, so it is refused.
function sequenceFor(version) {
    const [major, minor, patch] = parseVersion(version, "Version");
    if (minor >= 1000 || patch >= 1000) fail(`Version "${version}" has a minor or patch number of 1000 or more`);
    const sequence = major * 1000000 + minor * 1000 + patch;
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail(`Version "${version}" gives no usable sequence number`);
    return sequence;
}

// The bytes a pull downloads: the config plus every compressed layer of one
// image manifest. An index is a list of images, not one image, so it is refused.
function imageSize(imageManifest) {
    const doc = imageManifest;
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) fail("The registry document is not a JSON object");
    if (Array.isArray(doc.manifests)) {
        fail("The registry returned an index, not an image manifest. The digest must name one platform image.");
    }
    const whole = (value, what) => {
        if (!Number.isSafeInteger(value) || value < 0) fail(`The image manifest has no valid ${what}`);
        return value;
    };
    if (typeof doc.config !== "object" || doc.config === null) fail("The image manifest has no config");
    if (!Array.isArray(doc.layers) || doc.layers.length === 0) fail("The image manifest has no layers");
    let size = whole(doc.config.size, "config size");
    doc.layers.forEach((layer, i) => {
        size += whole(layer && layer.size, `size for layer ${i}`);
    });
    return size;
}

// Builds the manifest object. Key order here is the key order in the file.
// sizeOf(image, digest) returns the size in bytes of that image manifest.
function buildManifest({ version, engineVersion, minimumUiVersion, image, digests, sizeOf }) {
    const sequence = sequenceFor(version);
    parseVersion(engineVersion, "Engine version");
    parseVersion(minimumUiVersion, "Minimum UI version");
    if (!IMAGE.test(image || "")) fail(`Image "${image}" is not an image name without a tag`);
    const variants = {};
    for (const v of VARIANTS) {
        const digest = digests[v.file];
        if (!DIGEST.test(digest || "")) fail(`The digest for ${v.file} is not sha256: and 64 lowercase hex digits`);
        const size = sizeOf(image, digest);
        if (!Number.isSafeInteger(size) || size < 1) fail(`The size for ${v.file} is not a positive whole number`);
        variants[v.id] = { kind: "container", image, digest, size, gpu: v.gpu, taskApiSocket: true };
    }
    return {
        schemaVersion: SCHEMA_VERSION,
        sequence,
        packageVersion: version,
        engineVersion,
        minimumUiVersion,
        variants
    };
}

// The one writer. Two-space indent, one newline at the end, UTF-8.
function renderManifest(manifest) {
    return new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n");
}

function pemToPkcs8(pem) {
    const m = /-----BEGIN PRIVATE KEY-----([^-]+)-----END PRIVATE KEY-----/.exec(pem);
    if (!m) fail("The private key is not a PKCS#8 PEM (BEGIN PRIVATE KEY)");
    return Buffer.from(m[1].replace(/\s+/g, ""), "base64");
}

function parsePublicKey(text) {
    const raw = Buffer.from(text.trim(), "base64");
    if (raw.length !== 32 || raw.toString("base64") !== text.trim()) {
        fail("The public key file must hold one base64 line of the 32 raw key bytes");
    }
    return raw;
}

async function signBytes(bytes, pem) {
    const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "Ed25519" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes));
}

async function verifyBytes(bytes, signature, publicKeyText) {
    if (signature.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", parsePublicKey(publicKeyText), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, signature, bytes);
}

// Only the command line below reaches the registry.
function registrySize(image, digest) {
    const p = Bun.spawnSync(["docker", "buildx", "imagetools", "inspect", `${image}@${digest}`, "--raw"]);
    if (p.exitCode !== 0) {
        fail(`Cannot read ${image}@${digest} from the registry: ${p.stderr.toString().trim() || "docker failed"}`);
    }
    let doc;
    try {
        doc = JSON.parse(p.stdout.toString());
    } catch {
        fail(`The registry document for ${image}@${digest} is not JSON`);
    }
    return imageSize(doc);
}

function readDigests(folder) {
    const digests = {};
    for (const v of VARIANTS) {
        const file = path.join(folder, v.file);
        if (!fs.existsSync(file)) fail(`The digest file ${file} is missing`);
        digests[v.file] = fs.readFileSync(file, "utf8").trim();
    }
    return digests;
}

function options(args, names) {
    const out = {};
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i];
        if (!name.startsWith("--") || !names.includes(name.slice(2)) || args[i + 1] === undefined) {
            fail(`Unknown or incomplete option ${name}\n\n${usage()}`);
        }
        out[name.slice(2)] = args[i + 1];
    }
    return out;
}

function need(opts, name) {
    if (!opts[name]) fail(`--${name} is required\n\n${usage()}`);
    return opts[name];
}

function usage() {
    const lines = fs.readFileSync(__filename, "utf8").split("\n").slice(1);
    return lines
        .slice(0, lines.findIndex((l) => !l.startsWith("//")))
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n");
}

async function main(argv) {
    const [command, ...rest] = argv;
    if (command === "build") {
        const opts = options(rest, ["engine-version", "image", "digests", "out", "version", "package"]);
        const pkg = JSON.parse(fs.readFileSync(opts.package || path.join(__dirname, "..", "package.json"), "utf8"));
        const manifest = buildManifest({
            version: opts.version || pkg.version,
            engineVersion: need(opts, "engine-version"),
            minimumUiVersion: pkg.minimumUiVersion,
            image: need(opts, "image"),
            digests: readDigests(need(opts, "digests")),
            sizeOf: registrySize
        });
        fs.writeFileSync(need(opts, "out"), renderManifest(manifest));
    } else if (command === "sign") {
        const opts = options(rest, ["manifest", "out"]);
        const pem = fs.readFileSync(0, "utf8");
        const signature = await signBytes(fs.readFileSync(need(opts, "manifest")), pem);
        fs.writeFileSync(need(opts, "out"), signature);
    } else if (command === "verify") {
        const opts = options(rest, ["manifest", "signature", "public-key"]);
        const ok = await verifyBytes(
            fs.readFileSync(need(opts, "manifest")),
            fs.readFileSync(need(opts, "signature")),
            fs.readFileSync(need(opts, "public-key"), "utf8")
        );
        if (!ok) fail("The signature does not match the manifest and the public key");
        console.log("Signature verified");
    } else {
        fail(`Unknown command "${command || ""}"\n\n${usage()}`);
    }
}

module.exports = { sequenceFor, imageSize, buildManifest, renderManifest, signBytes, verifyBytes, parsePublicKey };

if (require.main === module) {
    main(process.argv.slice(2)).catch((err) => {
        console.error("Error: " + err.message);
        process.exit(1);
    });
}
