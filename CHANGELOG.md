# Changelog

AIDM API uses [Semantic Versioning](https://semver.org). Each release names the NodeODX version it is based on.

The API version follows semantic versioning from NodeODX 2.4.0. The AIDM 0.1.0 release ships engine 0.1.0 with API 2.5.0.

## Unreleased

- Replace the invalid test-mode GLB placeholder with a self-contained textured model. Scene, geometry and embedded-texture checks are in `tests/unit/model-fixture.test.js`; the compatibility harness checks archived model bytes and skip-output behavior (#67).

- Combined the eight dependency changes into one merge candidate under the approved plan for #11. Component pull requests #58 through #65 remain review records. Evidence is in `docs/specs/0002-dependency-cleanup.md`, `tests/unit/` and `tests/compat/run.js`. One exact-head full release dry run is required before maintainer merge.

### Changed

- Added the dependency-cleanup plan in `docs/specs/0002-dependency-cleanup.md`, with one pull request per dependency and compatibility checks for each change (#11).
- Added `scripts/release-manifest.js`, a Bun script with three commands: `build` writes the release manifest from the digest files and the image sizes in the registry, `sign` signs it with an Ed25519 key read from standard input, and `verify` checks a signature against a public key file. `package.json` gains the `minimumUiVersion` key. Unit tests in `tests/unit/release-manifest.test.js` cover the sequence rule, the size rule, byte-exact output and the sign and verify round trip; the dry run of the pull request is the full test (#72).
- Replace direct `rimraf` cleanup calls with asynchronous recursive `fs.rm`. Missing paths are harmless, and removal errors still reach callbacks. The combined dependency cleanup also removes the unused transitive copy. Regression tests cover task deletion, upload cleanup and stale directories (#49).

- Task IDs use `crypto.randomUUID()` instead of the direct `uuid` dependency (#48). UUIDv4 format, uniqueness and supplied-ID validation are covered by `tests/unit/task-uuid.test.js`.
- Pinned `node-schedule` to 2.1.2. Task cleanup still runs hourly, and runtime checks still run every minute when enabled. `tests/unit/task-schedules.test.js` checks the callbacks, schedules and cancellation (#54).
- Replace `mv` with filesystem moves and a cross-device copy fallback for uploads, seed files and GCP files. Copy errors keep the source. Regression tests cover moves, collisions and failures (#50).
- Every release archive bundles 7-Zip 26.05 in `apps/7z/`. The Linux archives carry the static `7zzs`, the Windows archive `7za.exe` from the Extra package. `scripts/get-7zip.sh` downloads the official builds and checks them against `scripts/7zip-sha256sums.txt`. `THIRD-PARTY-NOTICES.txt` carries the licence text of each package, with the unRAR restriction on Linux. The compiled executable uses the bundled 7-Zip before any tool on the `PATH`, to extract zip files and to build `all.zip`. Source mode and the images still try `unzip`, then `7z`. On an archive, a corrupt zip now fails with "Could not extract .zip file, 7z exited with code 2". An installation with `unzip` on the `PATH` saw "Could not extract .zip file, unzip exited with code 9" before. The compatibility harness treats the two texts as equal in that one step, so no golden file changes. Evidence: `tests/unit/get-7zip.test.js`, `tests/unit/apps.test.js`, `tests/unit/ziputils.test.js`, `tests/unit/third-party-notices.test.js`, `tests/unit/compat-tool-message.test.js`, and the release workflow's dry run, which builds the archives and runs the harness on them (#74).

- Pinned `archiver` to 8.0.0 and switched the ZIP fallback to its `ZipArchive` constructor. Regression tests check complete archive contents, output-close ordering and error callbacks in `tests/unit/archive-fallback.test.js` (#53).

- ZIP URL downloads and task webhooks use built-in HTTP support instead of the deprecated `request` dependency. Downloads keep HEAD before GET, redirects and the existing invalid-URL and connection-refused messages. Webhooks keep their JSON payloads and retry policy. Regression tests in `tests/unit/http-client.test.js` cover these cases and failed download streams (#10).

- Pin `systeminformation` to 5.33.18. Callback, `/info` field mapping and credential-free S3 upload sizing tests in `tests/unit/systeminformation.test.js` preserve the CPU and memory contracts (#52).

- Upgraded `busboy` to exactly 1.6.0 and adapted multipart upload parsing. Upload regression tests cover fields, safe filenames, completion, malformed input, interrupted streams and cancellation in `tests/unit/storage.test.js`. The source compatibility harness passes its available scenarios with unchanged golden files (#51).

- A task can now be created from a folder the API can read. The new form field `imagesPath` works at `POST /task/new/init` and `POST /task/new` when the API runs with `--images_root` (config key `imagesRoot`) and the folder lies inside that root. `GET /info` then returns `"imagesPath": true`. Without the root the key is absent and the field is refused. The API links the top-level image and video files of the folder into the task, with a hard link or, when that fails, an absolute symbolic link. It never writes into the folder, and removing the task removes only the links. A move of the staging folder across devices keeps the links as links. Each refusal is an error in the response. Evidence is in `tests/unit/images-path.test.js`, `tests/unit/images-path-links.test.js`, the `images-path` harness scenario and the dry run on the three executables. In `golden/default.json` only the hash and length of the served `swagger.json` change (#47).

### Fixed

- Postprocessing reports an existing Entwine point cloud once, even when both `entwine` and `untwine` are installed. When output is missing, it tries `entwine` first and falls back to `untwine` if `entwine` is missing or fails. Regression tests in `tests/unit/postprocess.test.js` cover tool selection, temporary directory cleanup and nonfatal failures. Fixes #35.
- Without `7z`, wildcard outputs now reach `glob` and are included in `all.zip` instead of being skipped or throwing because the import was missing. Temporary engine-options files that cannot be deleted now produce a warning instead of a `TypeError`. Regression coverage is in `tests/unit/error-paths.test.js` (#14).
- `docs/swagger.json`, `docs/index.adoc` and the `/swagger.json` the API serves said version 2.5.0 in 2.6.1. They now say 2.6.1, and a unit test fails when a file that states the API version disagrees with `package.json` (#37).

### Removed

- `GET /info` no longer returns `upstreamVersion` and `engineUpstreamVersion`, and the startup line no longer prints them. This is a contract change made under the 2.7.0 spec and ADR 0004: a client that read either key now finds it absent, and `version` is the API version. The four golden files that record `/info` (`default`, `limits`, `token`, `zip-input-no-tools`) change only by the two keys (and, in `default`, the length and hash of the served `swagger.json`), and `tests/unit/systeminformation.test.js` checks that the response has neither.

## 2.6.1

AIDM API now runs on Bun and ships as one compiled executable. API behaviour is unchanged.

There is no 2.6.0 release. The tag `v2.6.0` exists, but its release run failed on GitHub's new Ubuntu 26.04 runners and published nothing (#29). Two checks in the release workflow broke there, not the API (#27, #28). 2.6.1 has the same changes, listed below.

### Changed

- The API runs on Bun 1.4.4, compiled into one executable with `bun build --compile`. The images contain no Node.js.
- The images build in two stages. The first stage compiles the API on the official Bun image. The second stage copies the executable and the resource files onto the engine image. `Dockerfile`, `Dockerfile.gpu` and `apptainer.def` all work this way.
- The image entry point is now `/var/www/aidm-api`. Flags passed to `docker run` work as before. If you override the entry point with `node index.js`, switch to `/var/www/aidm-api`.
- Resource files (`config-default.json`, `public/`, `helpers/`, `scripts/`, `docs/swagger.json`) are found in the executable's folder. Files the API writes (`data/`, `tmp/`) stay relative to the working directory.
- Dependencies are locked in `bun.lock`, and builds install exactly those versions. The version ranges in `package.json` are the same.
- Compiled builds do not read `.env` or `bunfig.toml` from the working directory, like Node.js 14.
- Errors for invalid JSON use Bun's wording. This covers an invalid `options` field on `POST /task/new`, and an invalid JSON body on `POST /task/cancel`, `/task/remove` and `/task/restart`. For example, `{"error": "Unexpected token n in JSON at position 1"}` is now `{"error": "JSON Parse error: Expected '}'"}`. The response shape and status code are the same.
- The API `version` is `2.6.1`. `services/nodeodx.service` starts `/www/aidm-api`.
- Each release has archives for linux-x64, linux-arm64 and windows-x64, each with the executable and the files it needs, plus a `SHA256SUMS` file. On Windows, only test mode works today.

### Fixed

- When neither `unzip` nor `7z` is installed, a task with a zip file (an upload or `zipurl`) now fails with the error "Could not extract .zip file, neither unzip nor 7z is installed". Before, the server crashed with "Callback was already called". The API also logs a warning at startup when both programs are missing. Fixes #9.
- When `7z` is not installed, a task no longer completes before `all.zip` is fully written. The API built the archive with its JavaScript fallback and reported completion when the archiver finished, before the file was closed. A client that downloaded `all.zip` right away got a truncated file or a wrong `Content-Length`. The task now completes when the file is closed. Fixes #17.

### Removed

- `install_deps.sh`, `node.sh`, `processes.json` and `scripts/winbundle.js`. The executable replaces them.
- The `node-unzip-2` dependency, which was the last fallback for zip files. Its dependencies `binary`, `buffers` (which had no licence), `chainsaw`, `fstream`, `match-stream`, `over`, `pullstream`, `slice-stream`, `setimmediate` and `traverse` go with it, and so do the packages that only they needed.

### Not changed

- Endpoints, request and response fields, command-line flags, JSON config keys and the output layout are the same as in 2.5.0.

### Known limitations

- On x64, the executable needs a CPU with SSE4.2 (Nehalem, 2008 or newer). Node.js 14 ran on any x86-64 CPU.
- Images are for Linux only. The CPU image runs on x86-64 and arm64, the GPU image on x86-64 only.

## 2.5.0

The first AIDM API release. It is NodeODX 2.4.0, packaged and named as AIDM API, and runs on the AIDM 0.1.0 engine. API behaviour is unchanged.

### Added

- `GET /info` has two new fields. `upstreamVersion` holds `NodeODX 2.4.0`. `engineUpstreamVersion` holds the ODX version the engine is based on, `ODX 3.8.4`, read from the engine's `UPSTREAM_VERSION` file.
- At startup, the log shows the API and engine versions, for example `AIDM API 2.5.0 (NodeODX 2.4.0), engine aidm 0.1.0 (ODX 3.8.4)`.

### Changed

- The API `version` is `2.5.0`. It is a minor version because the only API change is two new optional fields.
- The default base images are `ghcr.io/aidronemap/aidm:0.1.0` and `ghcr.io/aidronemap/aidm:0.1.0-gpu`.
- With the AIDM 0.1.0 engine, `GET /info` reports `engine` as `aidm` and `engineVersion` as `0.1.0`.
- The web page, `--help` and engine error messages say AIDM API or AIDM.
- The images carry OCI labels for source, version, licence, title and description, in place of the `MAINTAINER` line.

### Not changed

- Endpoints, request and response fields, command-line flags and JSON config keys are the same as in NodeODX 2.4.0. No field was removed or renamed.
- The log file is still named `NodeODX.log`, because the `instance` config key sets it.

### Known limitations

- The image runs Node.js 14, which no longer receives security updates. Moving to a supported Node.js release is planned as its own change.
- Images are for Linux only. The CPU image runs on x86-64 and arm64, the GPU image on x86-64 only.
