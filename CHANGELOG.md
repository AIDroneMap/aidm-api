# Changelog

AIDM API uses [Semantic Versioning](https://semver.org). Each release names the NodeODX version it is based on.

The API version follows semantic versioning from NodeODX 2.4.0. The AIDM 0.1.0 release ships engine 0.1.0 with API 2.5.0.

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
- Images are for Linux on x86-64. arm64 images will follow.
