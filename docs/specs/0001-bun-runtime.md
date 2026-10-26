# 0001: Run AIDM API on Bun and ship it as one executable

Status: implemented. Shipped in AIDM API 2.6.1.

The plan targeted 2.6.0. That version was tagged but never released, because its release run failed (#29). Where the text below says 2.6.0, it means the release that shipped as 2.6.1.

## Problem

AIDM API 2.5.0 runs on Node.js 14. Node.js 14 has had no security fixes since April 2023. The images also install it at build time with nvm from a curl script, then run `npm install` without a lock file, so two builds of the same commit can contain different dependency versions.

A desktop app is planned that starts the API next to the engine on the user's machine. Asking users to install Node.js first is not acceptable for that.

`aidm-ui` already uses Bun. If the API also runs on Bun, the project has one JavaScript toolchain, and `bun build --compile` turns the API into one executable per platform.

## Goal

- The images run a compiled executable. No nvm, no Node.js and no `npm install` at image build time.
- Release archives for `linux-x64`, `linux-arm64` and `windows-x64`, each with the executable and the files it needs.
- API behaviour does not change: same endpoints, fields, status codes, error messages, command-line flags, config keys and output layout.

Out of scope: a native Windows engine, bundling `7z.exe` and `unzip.exe` for Windows, replacing old dependencies that still work, and `contrib/`.

## Findings from the spike

Done on 23 October 2026 on `master` at `a335270`, on Linux x64, with Bun 1.4.4 (`1.4.4+38afee6c8`, released 22 October 2026) and the official Node.js 14.21.3 build for comparison. Docker is not installed on the machine used, so the images are tested in CI.

### Bun runs the API unchanged

`bun install` installed 676 packages in under a second and wrote `bun.lock`. `bun index.js --test` started, and these calls gave the same results as Node.js 14 with the same `node_modules`: `/info`, `/options`, `/`, `/swagger.json`, `/task/new` with images, with `zipurl` and with an uploaded zip, the chunked `init`, `upload` and `commit` calls, `info`, `output`, `download`, `list`, `cancel`, `restart` and `remove`.

None of the dependencies has to change to run on Bun:

| Dependency | Concern | Result on Bun 1.4.4 |
| --- | --- | --- |
| `request` 2.88 | Deprecated | Works. Used for `zipurl` downloads and webhooks. See "Dependencies" below. |
| `busboy` 0.2 | Very old stream code | Works for single and chunked uploads. |
| `systeminformation` 3.42 | Old, reads system data per OS | `/info` returns the same memory and core values as Node.js 14 on Linux. Windows is checked in CI. |
| `node-unzip-2` 0.2 | Old | Behaves the same as on Node.js 14, including a crash (see below). |
| `archiver` 3 | Old stream code | Works. It is the fallback when `7z` is missing. |
| `@aws-sdk/*` v3 | Large, many modules | Loads in the compiled executable. Not tested against a real S3 endpoint. |

### Two corrections to what we expected

- `node-unzip-2` is not only used by `scripts/winbundle.js`. `libs/ziputils.js` uses it to extract zip files when neither `unzip` nor `7z` is installed. On that path the server crashes with `Callback was already called` from `async`, on Node.js 14 and on Bun alike. The images install `unzip`, so they never take this path. A standalone executable on a machine without `unzip` and `7z` does, which includes Windows today. This is an existing bug and gets its own issue.
- Without `7z`, task archives are built with `archiver` instead. The API logs a warning and works.

### Invalid JSON errors are worded by the engine

Found by the compatibility harness after the spike. An invalid `options` field on `/task/new`, or an invalid JSON body on `/task/cancel`, `/task/remove` or `/task/restart`, returns the JavaScript engine's parse error to the client:

| Input | Node.js 14 (V8 8.4) | Bun 1.4.4 (JavaScriptCore) |
| --- | --- | --- |
| `options={not json` | `Unexpected token n in JSON at position 1` | `JSON Parse error: Expected '}'` |
| body `{"uuid": ` | `Unexpected end of JSON input` | `JSON Parse error: Unexpected EOF` |

Clients can read this text. A small module could rebuild the Node.js 14 wording (it matched Node.js 14.21.3 on about 1.2 million invalid inputs), but the maintainer chose to accept Bun's wording instead (decision 14). The response shape and status code stay the same.

### `__dirname` in a compiled executable

In an executable built by `bun build --compile`, `__dirname` and `__filename` are the build machine's source paths, written into the binary as strings. They are not `/$bunfs/root`. I checked this with a small probe and with the API itself: an executable compiled in `/tmp/build-src` failed at startup with `Log directory '/tmp/build-src' cannot be written to` once that folder was deleted. On the build machine it works, because the folder still exists, so a test there can pass by accident.

Bun tracks this in [oven-sh/bun#44068](https://github.com/oven-sh/bun/issues/44068) and [oven-sh/bun#29066](https://github.com/oven-sh/bun/pull/29066), both open. Other values in a compiled executable on Bun 1.4.4:

| Expression | Value |
| --- | --- |
| `process.execPath` | Real path of the executable |
| `process.argv[0]` | `bun` |
| `process.argv[1]`, `Bun.main` | `/$bunfs/root/<name>` (Windows: `B:/~BUN/root/<name>`) |
| `Bun.isStandaloneExecutable` | `true` (and `false` under `bun index.js`) |

Files embedded with `--asset` can be read with `readFileSync`, but `createReadStream` fails, so `express.static` cannot serve them, and child processes (`python`, `bash`) cannot see them at all. The resource folders therefore ship as normal files next to the executable.

### Other compile behaviour

- A compiled executable loads `.env` and `bunfig.toml` from the working directory by default. Node.js 14 never did. A `.env` with `PORT` or `AWS_ACCESS_KEY_ID` would silently change the configuration, so builds pass `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`.
- Cross-compiling (`--target`) downloads the target runtime from the npm registry, with no checksum under our control. `--compile-executable-path <file>` uses a local Bun binary instead. CI downloads the release zips from GitHub, checks their SHA-256 against values in this repository, and passes them with that flag.
- Since Bun 1.4, x64 has one binary with a Nehalem (SSE4.2) floor that picks AVX2 or AVX-512 code at run time. `bun-linux-x64.zip` and `bun-linux-x64-baseline.zip` hold byte-identical `bun` binaries (SHA-256 `10702245...`), and so do `bun-windows-x64.zip` and `bun-windows-x64-baseline.zip` (`cb1d8e65...`). The `-baseline` targets are aliases. The official `oven/bun` image installs the baseline zip on amd64.
- Checked under emulation with `qemu-x86_64 -cpu Nehalem`, a CPU with SSE4.2 but no AVX. The compiled API passed all 150 harness steps. Under `-cpu core2duo` (no SSE4.2) Bun stops with an illegal instruction. A control program built with AVX2 also stops with an illegal instruction under `-cpu Nehalem`, so the emulator does reject AVX2. The x64 executables need SSE4.2, not AVX2. CI repeats the Nehalem run for Linux x64.
- Compiling the API takes under a second and gives an executable of about 117 MB (Linux x64).

### Files that assume Node.js

`Dockerfile`, `Dockerfile.gpu`, `install_deps.sh`, `node.sh`, `apptainer.def`, `services/nodeodx.service`, `processes.json` (pm2) and `scripts/winbundle.js` (nexe with Node.js 14.15.3).

## Approach

### Runtime

Bun 1.4.4, compiled with:

```
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  --target <target> [--compile-executable-path <bun binary>] index.js --outfile <file>
```

Targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`. No minification, so stack traces stay readable. No bytecode cache for now.

One script, `scripts/build.sh`, holds these flags. The Dockerfiles, CI and local builds all call it.

### One Bun version

- `.bun-version` holds the version, `1.4.4`. Local builds and CI read it. `scripts/build.sh` stops if `bun --version` differs.
- `scripts/bun-sha256sums.txt` holds the SHA-256 of the three release zips that CI downloads, copied from that release's `SHASUMS256.txt`.
- The Dockerfiles and `apptainer.def` need the image tag and digest written out in `FROM`, for example `oven/bun:1.4.4-debian@sha256:93d5...`. Docker cannot read the version from a file there. A check in CI fails when these tags differ from `.bun-version`.

Updating Bun means changing those three places in one pull request. The check catches a missed one.

### Dependencies

No dependency changes are needed to run on Bun, so none are made in this work. Each one below gets an issue instead.

- `request` stays for now. Replacing it with `fetch` changes the text of `status.errorMessage` for failed `zipurl` downloads, which clients can read. For example, Node.js 14 and Bun with `request` both report `connect ECONNREFUSED 127.0.0.1:1` and `Invalid URI "not-a-url"`, and Bun's `fetch` reports different messages. That is an API change, so it needs its own decision.
- `busboy` 0.2, `systeminformation` 3.42, `node-unzip-2`, `archiver` 3, `uuid` 3, `rimraf` 2 and `node-schedule` 1 work and stay.
- `bun.lock` is committed. Every install in the Dockerfiles and CI uses `bun install --frozen-lockfile`, so builds use the locked versions. The `^` ranges in `package.json` stay as they are. The lock file pins them, and rewriting them would add 15 dependency changes to a runtime change.

Dev tooling (`Gruntfile.js`, `docs/generateSwaggerAPI.js`, `nodemon`) is not shipped. It stays as it is. `bun install` still installs it for development, and `--production` leaves it out of builds.

### Invalid JSON errors

The API returns Bun's own wording. The two affected golden steps are re-recorded with Bun, and the 2.6.0 changelog lists the change. Every other golden step is still the Node.js 14 recording.

### Zip files without `unzip` or `7z`

`node-unzip-2`, the last-resort zip extractor, crashed the server (#9) and pulled in `buffers@0.1.1`, which has no licence. It is removed, together with the packages only it used. When neither `unzip` nor `7z` is installed, a task with a zip file now fails with `Could not extract .zip file, neither unzip nor 7z is installed`, and the server keeps running. A unit test and a harness scenario (`zip-input-no-tools`) check it.

### Finding resource files

A new module, `libs/appRoot.js`, returns the folder that holds the resource files:

- compiled (`Bun.isStandaloneExecutable` is true): the folder of `process.execPath`;
- otherwise: the repository root, from the module's own `__dirname`.

These read-only files resolve against it:

| Code | Today | After |
| --- | --- | --- |
| `index.js` | `public/`, `docs/swagger.json`, `./package.json` (current directory) | app root; `package.json` is loaded with `require`, so it is built into the executable |
| `config.js` | `config-default.json` (current directory) | app root when `--config` is not given; a `--config` path still resolves against the current directory |
| `libs/odmRunner.js` | `helpers/`, `tests/` (`__dirname`) | app root |
| `libs/processRunner.js` | `scripts/`, `tests/` (`__dirname`) | app root |
| `libs/Task.js` | `tests/processing_results` (current directory) | app root |
| `libs/apps.js` | `apps/7z`, `apps/unzip` (current directory) | app root |
| `libs/logger.js` | default log folder (`__dirname/..`) | app root; `logger.logDirectory` still overrides it |

Folders the API writes to stay relative to the current directory, as today: `data/`, `tmp/`, and `tests/data/` in test mode. The images keep `WORKDIR /var/www`, so `/var/www/data` stays where existing volume mounts expect it.

When the API runs from the repository or from its install folder, every path is the same as before.

### Images

`Dockerfile` and `Dockerfile.gpu` become two-stage builds, still one `docker build` command:

1. `FROM oven/bun:1.4.4-debian@sha256:<digest> AS build`. The image runs on the target platform, so it compiles natively for amd64 and arm64 and downloads no runtime. It runs `bun install --frozen-lockfile --production` and `scripts/build.sh`.
2. `FROM ${FROM_REPO}`. Copies the executable to `/var/www/aidm-api`, plus `config-default.json`, `public/`, `helpers/`, `scripts/` and `docs/swagger.json`. Installs `unzip` and `p7zip-full`, keeps the `untwine`, `entwine` and `pdal` links, and runs `aidm-api --powercycle` at build time as before.

`ENTRYPOINT` becomes `["/var/www/aidm-api"]`. Arguments given to `docker run` reach the API as before. `tests/` stays out of the images, as it is today (`.dockerignore`).

`apptainer.def` uses the same two stages (`Stage: build`, then `%files from build`). `services/nodeodx.service` runs `/www/aidm-api`. `install_deps.sh`, `node.sh`, `processes.json` and `scripts/winbundle.js` are deleted.

### Release archives

| Platform | File | Executable |
| --- | --- | --- |
| Linux x64 | `aidm-api-<version>-linux-x64.tar.gz` | `aidm-api` |
| Linux arm64 | `aidm-api-<version>-linux-arm64.tar.gz` | `aidm-api` |
| Windows x64 | `aidm-api-<version>-windows-x64.zip` | `aidm-api.exe` |

Each archive has one top folder, `aidm-api-<version>-<platform>/`, with:

```
aidm-api(.exe)
config-default.json
public/
helpers/
scripts/
docs/swagger.json
tests/                 sample outputs for --test (about 1.2 MB)
LICENSE
SOURCE
THIRD-PARTY-NOTICES.txt
```

`SHA256SUMS` lists the three archives. `THIRD-PARTY-NOTICES.txt` has the Bun licence (MIT), the JavaScriptCore and WebKit notice (LGPL-2, with a pointer to Bun's relinking instructions and to the Bun source at tag `bun-v1.4.4`), the list of libraries Bun links statically (from https://bun.com/docs/project/license), and the name, version, licence and licence text of every npm package built into the executable.

On a tag push, the workflow attaches the archives and `SHA256SUMS` to the draft release it already creates. It never changes a published release.

## Test plan

1. **Compatibility harness** (pull request 2). `tests/compat/run.js` starts the API in `--test` mode, calls every endpoint in `docs/swagger.json` with success and error cases, removes values that change between runs (UUIDs, dates, timings, memory, CPU count, random ports) and compares the responses with golden files. The golden files are recorded with Node.js 14.21.3 on the current code. The script has no dependencies and runs on Node.js 14 and on Bun.
2. **Bun** (pull request 3). The harness passes against `bun index.js` and against the compiled executable, with the golden files unchanged.
3. **Compiled outside the build folder.** The executable runs from a copy of its folder after the build folder is deleted, and also with a different working directory.
4. **Images** (pull request 3). CI builds the cpu-amd64, cpu-arm64 and gpu-amd64 images. `scripts/smoke-test.sh api <image>` from the `aidm` repository processes 18 real images through the API.
5. **Executables in CI** (pull request 4). The archives are built once on Linux. Each one runs on its own platform (`ubuntu-latest`, `ubuntu-24.04-arm`, `windows-latest`): `--test --powercycle`, then the harness. The runners have no engine, so plain `--powercycle` (which asks the engine for its options) runs only at image build time.

On Windows, the cases that need `unzip` are skipped when neither `unzip` nor `7z` is on the `PATH`, because the JavaScript fallback crashes (see above). The harness prints what it skipped.

## Pull requests

1. This spec.
2. Compatibility harness and golden files, on `master`, still on Node.js 14.
3. Switch to Bun: `bun.lock`, `libs/appRoot.js`, Dockerfiles, `apptainer.def`, service file, deleted Node.js files, docs, version `2.6.0`. Stacked on 2.
4. Zip files without `unzip` or `7z`: remove `node-unzip-2`, fail the task with a clear error. Stacked on 3. Added after the maintainer's review.
5. Executables in CI: archive build, tests on three platforms, upload to the draft release. Stacked on 4.

## Decisions

Made while the maintainer was away. Each can be revisited in review.

1. **Bun 1.4.4.** The latest stable release on 23 October 2026. It is one day old. If 1.4.5 is out before 2.6.0 ships, updating is a three-file change.
2. **Keep `request` in 2.6.0.** It works on Bun, and replacing it changes `status.errorMessage` texts. An issue tracks the replacement.
3. **No dependency upgrades.** None is needed for Bun. Each old dependency gets an issue.
4. **Resources resolve against the executable, written files against the working directory.** This keeps the image layout and volume mounts unchanged and gives the desktop app a folder it can start the executable from.
5. **`config-default.json` resolves against the app root** when `--config` is not given. Without it the API exits at startup, so an executable started from another folder would never run. An explicit `--config` path keeps today's meaning.
6. **`package.json` is built into the executable**, so `/info` reports the version the executable was built from.
7. **No `.env` or `bunfig.toml` autoload** in compiled builds, to match Node.js 14.
8. **No minify, no bytecode.** Readable stack traces matter more than startup time for a server.
9. **x64 CPU floor is Nehalem (SSE4.2, 2008).** Node.js 14 ran on any x86-64 CPU. Bun has no build for older CPUs. The engine has much higher demands anyway, so this is noted in the changelog rather than worked around.
10. **Images still leave out `tests/`.** Test mode does not work in the images today, and adding it is a separate change. The archives include `tests/` because the CI checks need test mode.
11. **The image entry point changes** from `/usr/bin/node /var/www/index.js` to `/var/www/aidm-api`. Flags passed to `docker run` work as before. Anyone who overrides the entry point with `node index.js` must switch to `/var/www/aidm-api`. The changelog says so.
12. **Archive format.** `.tar.gz` for Linux keeps the executable bit, `.zip` for Windows.
13. **The log file name stays `NodeODX.log`.** It comes from the `instance` config key.
14. **Accept Bun's wording of invalid JSON errors** (maintainer's decision, replacing a first version that rebuilt the Node.js 14 wording). The response shape and status code stay the same. The changelog lists the change.
15. **The harness records the API version as `<version>`.** `/info` returns the version, which changes with every release. The harness checks that it looks like `1.2.3`.
16. **No `node-unzip-2`** (maintainer's decision). Without `unzip` or `7z`, a task with a zip file fails with a clear error instead of crashing the server.
17. **The GPU image gets a startup check in CI, not the smoke test.** It needs an NVIDIA GPU at run time and GitHub runners have none. The job builds the image and runs it with `--powercycle`.
18. **CI dry runs before Monday.** The release workflow's first job checks that the AIDM 0.1.0 base images are public, and fails until they are. The executable jobs do not depend on it, so they run now. For the images, a new `base=upstream` option builds a dry run on WebODM's ODX images (pinned by digest) and runs the smoke test from `aidm` master. It refuses to publish. The image jobs are re-run on the AIDM base once 0.1.0 is published.

## Issues to open

- Windows: no bundled `7z.exe` and `unzip.exe`, so zip uploads hit the crashing JavaScript fallback.
- `node-unzip-2` fallback crashes with `Callback was already called` (Node.js 14 and Bun).
- Replace `request` (deprecated), deciding what `status.errorMessage` says for failed downloads.
- Upgrade or replace `busboy` 0.2, `systeminformation` 3.42, `archiver` 3, `node-unzip-2`, `uuid` 3, `rimraf` 2, `node-schedule` 1.
- `contrib/` still describes the NodeODX setup.
- Move dev tooling (`Gruntfile.js`, `nodemon`, `docs/generateSwaggerAPI.js`) to Bun or remove it.
- Existing bugs the harness found, all the same on Node.js 14 and Bun: every error response is HTTP 200; the no-7z zip fallback calls `glob` without requiring it; an uploaded `.zip` other than `seed.zip` is deleted without being extracted; `console.warning` does not exist.
