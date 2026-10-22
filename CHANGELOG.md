# Changelog

AIDM API uses [Semantic Versioning](https://semver.org). Each release names the NodeODX version it is based on.

Numbering starts at 3.0.0, above NodeODX 2.4.0. Clients read the API `version` from `GET /info`, and PyODX and WebODM switch to older code paths below 1.4.0 and 1.5.1. A lower number would break them.

## 3.0.0

The first AIDM API release. It is NodeODX 2.4.0, packaged and named as AIDM API, and runs on the AIDM 0.1.0 engine. API behaviour is unchanged.

### Added

- `GET /info` has two new fields. `upstreamVersion` holds `NodeODX 2.4.0`. `engineUpstreamVersion` holds the ODX version the engine is based on, `ODX 3.8.4`, read from the engine's `UPSTREAM_VERSION` file.
- At startup, the log shows the API and engine versions, for example `AIDM API 3.0.0 (NodeODX 2.4.0), engine aidm 0.1.0 (ODX 3.8.4)`.

### Changed

- The API `version` is `3.0.0`.
- The default base images are `ghcr.io/aidronemap/aidm:0.1.0` and `ghcr.io/aidronemap/aidm:0.1.0-gpu`.
- With the AIDM 0.1.0 engine, `GET /info` reports `engine` as `aidm` and `engineVersion` as `0.1.0`.
- The web page, `--help` and engine error messages say AIDM API or AIDM.
- The images carry OCI labels for source, version, licence, title and description, in place of the `MAINTAINER` line.

### Not changed

- Endpoints, request and response fields, command-line flags and JSON config keys are the same as in NodeODX 2.4.0. No field was removed or renamed.
- The log file is still named `NodeODX.log`, because the `instance` config key sets it.

### Known limitations

- The image runs Node.js 14, which no longer receives security updates. Moving to a supported Node.js release is planned as its own change.
- Images are for Linux on x86-64. arm64 images will follow.
