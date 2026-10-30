# ADR 0003: Release archives bundle 7-Zip only

Status: accepted, October 2026

## Context

Issue #8 asks that a release archive need nothing on the operator's PATH, which is also the rule of the engine manager in aidm-ui. The API used `unzip` first and `7z` as the fallback.

A scratch machine showed that 7-Zip alone passes the golden scenarios, with one error string different. A source build with RAR disabled works on x64. The Windows Extra binary has no RAR code. The official Linux build has the RAR reader, and with it the unRAR restriction.

Info-ZIP `unzip` 6.0 dates from 2009, has no official Windows x64 build, and distributions carry patches its source lacks.

## Decision

Each archive bundles 7-Zip 26.05 and nothing else. The official binaries are pinned by checksum: the static `7zzs` on Linux and `x64/7za.exe` on Windows. The notices take the licence text from the pinned package.

In an executable the bundled tool comes first, and `PATH` is the fallback. In source mode and in the images, `PATH` is the whole rule.

The harness treats the two corrupt-zip messages as the same, so the golden file stays as it is.

Considered and rejected:

- Bundling Info-ZIP `unzip` too. See its state above.
- A source build with RAR disabled. It works, but arm64 would need a cross-compiler or a new job.
- Changing the API's error text. It would change the golden file and the message clients see.
- Keeping `unzip` first. The archive would behave differently on each machine.

## Consequences

- The unRAR restriction text ships in the notices.
- The images are untouched. They still install their own tools.
- Windows runs the zip scenario for the first time.
- macOS has an official build ready when #24 comes.
