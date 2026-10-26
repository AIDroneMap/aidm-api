# Changelog

AIDM API uses [Semantic Versioning](https://semver.org). Each release names the NodeODX version it is based on.

The API version follows semantic versioning from NodeODX 2.4.0. The AIDM 0.1.0 release ships engine 0.1.0 with API 2.5.0.

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
