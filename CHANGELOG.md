# Changelog

AIDM API uses [Semantic Versioning](https://semver.org).

The AIDM 0.1.0 release ships engine 0.1.0 with API 2.5.0.

## 2.7.0

2.7.0 is the task API of AIDroneMap 0.2. It is released together with engine 0.2.0 and the first tag of [aidm-ui](https://github.com/AIDroneMap/aidm-ui), and its images are built on engine 0.2.0. Each release now publishes a signed manifest, `manifest.json` with `manifest.json.sig`, and aidm-ui installs the engine from it. The API can listen on a Unix socket next to its port. It can also create a task from a folder on its own machine, through links instead of copies. Every release archive bundles 7-Zip, so zip uploads and zip addresses need no tool on the `PATH`. On an archive, a corrupt zip therefore fails with a message that names 7-Zip where it named `unzip` before. `GET /info` no longer returns `upstreamVersion` and `engineUpstreamVersion`: a client that read them finds them absent.

### Added

- Each release publishes `manifest.json` and its raw Ed25519 signature `manifest.json.sig` next to the archives, and aidm-ui installs the engine from them. The manifest names the three images `linux-amd64-cpu`, `linux-arm64-cpu` and `linux-amd64-gpu`, each by digest, with its download size and `taskApiSocket: true`. It carries the sequence number 2007000 and the lowest aidm-ui version that can read it, 0.1.0, from the new `minimumUiVersion` key of `package.json`. The tag run signs the manifest and checks the signature against `.github/manifest-public-key.txt` before it uploads anything, so a wrong key fails the release. `scripts/release-manifest.js` has the three commands: `build` writes the manifest from the digest files and the image sizes in the registry, `sign` signs it with a key read from standard input, and `verify` checks a signature against a public key file. Evidence: `tests/unit/release-manifest.test.js` covers the sequence rule, the size rule, byte-exact output and the sign and verify round trip, and the release workflow's dry run signs the manifest with a key made in the run and checks it with aidm-ui's own verifier (#25, #72, #73).
- The API can listen on a Unix socket path next to its port, set with `--socket <path>` or the `socket` key of the config file. Every route and the token check are the same on both. The API creates the socket with mode 0600 and removes it on SIGTERM and SIGINT. At start it removes a socket left at the path by a crash; any other file there stops the start and stays. Windows refuses the option with an error. Evidence: `tests/unit/task-api-socket.test.js`, the `socket` and `socket-token` scenarios of the compatibility harness (the Windows executable checks the refusal instead), and the release workflow's dry run (#34).
- A task can now be created from a folder the API can read. The new form field `imagesPath` works at `POST /task/new/init` and `POST /task/new` when the API runs with `--images_root` (config key `imagesRoot`) and the folder lies inside that root. `GET /info` then returns `"imagesPath": true`. Without the root the key is absent and the field is refused. The API links the top-level image and video files of the folder into the task, with a hard link or, when that fails, an absolute symbolic link. It never writes into the folder, and removing the task removes only the links. A move of the staging folder across devices keeps the links as links. Each refusal is an error in the response. Evidence is in `tests/unit/images-path.test.js`, `tests/unit/images-path-links.test.js`, the `images-path` harness scenario and the dry run on the three executables. In `golden/default.json` only the hash and length of the served `swagger.json` change (#47).
- Every release archive bundles 7-Zip 26.05 in `apps/7z/`, so zip uploads, zip addresses and `all.zip` work on every platform with no zip tool installed. The Linux archives carry the static `7zzs`, the Windows archive `7za.exe` from the Extra package. `scripts/get-7zip.sh` downloads the official builds and checks them against `scripts/7zip-sha256sums.txt`. `THIRD-PARTY-NOTICES.txt` carries the licence text of each package, with the unRAR restriction on Linux. The compiled executable uses the bundled 7-Zip before any tool on the `PATH`, to extract zip files and to build `all.zip`. Source mode and the images still try `unzip`, then `7z`. Evidence: `tests/unit/get-7zip.test.js`, `tests/unit/apps.test.js`, `tests/unit/ziputils.test.js`, `tests/unit/third-party-notices.test.js`, and the release workflow's dry run, which builds the archives and runs the harness on each executable with the bundled 7-Zip as its only zip tool, Windows included (#8, #74, #75).

### Changed

- The images are built on engine 0.2.0: `ghcr.io/aidronemap/aidm:0.2.0` in `Dockerfile` and `apptainer.def`, `ghcr.io/aidronemap/aidm:0.2.0-gpu` in `Dockerfile.gpu`. The release manifest names engine 0.2.0. The API `version` is `2.7.0`, and `tests/unit/version-strings.test.js` checks every file that states it. Evidence: the release workflow's dry run builds the three images on engine 0.2.0 and runs a task through the GPU image (#76).
- On a release archive, a corrupt zip now fails with "Could not extract .zip file, 7z exited with code 2", because the archive runs its bundled 7-Zip. An installation with `unzip` on the `PATH` saw "Could not extract .zip file, unzip exited with code 9" before. The shape of the error is the same, and source mode and the images still run `unzip` first. The compatibility harness treats the two texts as equal in that one step, so no golden file changes. Evidence: `tests/unit/ziputils.test.js` and `tests/unit/compat-tool-message.test.js` (#74).
- Old dependencies were replaced or upgraded, one change per dependency, under the plan in `docs/specs/0002-dependency-cleanup.md` (#11). `uuid`, `mv`, `rimraf` and `request` are gone: the API uses what the runtime provides instead. Requests and responses are the same, and the compatibility harness passes with its golden files unchanged by these changes. The entries below name each change and its tests.
- Task IDs use `crypto.randomUUID()` instead of the `uuid` dependency. UUIDv4 format, uniqueness and supplied-ID validation are covered by `tests/unit/task-uuid.test.js` (#48).
- `mv` is replaced with filesystem moves and a cross-device copy fallback for uploads, seed files and GCP files. Copy errors keep the source. Regression tests cover moves, collisions and failures (#50).
- `rimraf` is replaced with asynchronous recursive `fs.rm`. Missing paths are harmless, and removal errors still reach callbacks. Its unused transitive copy is gone too. Regression tests cover task deletion, upload cleanup and stale directories (#49).
- ZIP URL downloads and task webhooks use built-in HTTP support instead of the deprecated `request` dependency. Downloads keep HEAD before GET, redirects and the existing invalid-URL and connection-refused messages. Webhooks keep their JSON payloads and retry policy. Regression tests in `tests/unit/http-client.test.js` cover these cases and failed download streams (#10).
- `archiver` is pinned to 8.0.0, and the ZIP fallback uses its `ZipArchive` constructor. Regression tests check complete archive contents, output-close ordering and error callbacks in `tests/unit/archive-fallback.test.js` (#53).
- `busboy` is upgraded to exactly 1.6.0, and multipart upload parsing is adapted to it. Upload regression tests cover fields, safe filenames, completion, malformed input, interrupted streams and cancellation in `tests/unit/storage.test.js` (#51).
- `node-schedule` is pinned to 2.1.2. Task cleanup still runs hourly, and runtime checks still run every minute when enabled. `tests/unit/task-schedules.test.js` checks the callbacks, schedules and cancellation (#54).
- `systeminformation` is pinned to 5.33.18. Tests in `tests/unit/systeminformation.test.js` cover the callbacks, the `/info` field mapping and credential-free S3 upload sizing, and keep the CPU and memory values the same (#52).

### Fixed

- Test mode returns a valid, self-contained textured model where it returned an invalid GLB placeholder. Scene, geometry and embedded-texture checks are in `tests/unit/model-fixture.test.js`; the compatibility harness checks archived model bytes and skip-output behavior (#67).
- Postprocessing reports an existing Entwine point cloud once, even when both `entwine` and `untwine` are installed. When output is missing, it tries `entwine` first and falls back to `untwine` if `entwine` is missing or fails. Regression tests in `tests/unit/postprocess.test.js` cover tool selection, temporary directory cleanup and nonfatal failures (#35).
- Without `7z`, wildcard outputs now reach `glob` and are included in `all.zip` instead of being skipped or throwing because the import was missing. Temporary engine-options files that cannot be deleted now produce a warning instead of a `TypeError`. Regression coverage is in `tests/unit/error-paths.test.js` (#14).
- In 2.6.1, `docs/swagger.json`, `docs/index.adoc` and the `/swagger.json` the API serves said version 2.5.0. They now say the API version, and a unit test fails when a file that states the API version disagrees with `package.json` (#37).

### Removed

- `GET /info` no longer returns `upstreamVersion` and `engineUpstreamVersion`, and the startup line no longer prints them. This is a contract change made under the 2.7.0 spec and ADR 0004: a client that read either key now finds it absent, and `version` is the API version. The four golden files that record `/info` (`default`, `limits`, `token`, `zip-input-no-tools`) change only by the two keys (and, in `default`, the length and hash of the served `swagger.json`), and `tests/unit/systeminformation.test.js` checks that the response has neither (#69).

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
