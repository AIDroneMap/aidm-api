# Self-contained test-mode model

## Problem

Issue #67 reports that the test-mode GLB contains only `glTF` and a newline.
Archive listings accept it, but model viewers cannot open it. This blocks the
viewer acceptance in AIDroneMap/aidm-ui#77.

## Approach

Replace that fixture with a deterministic GLB 2 containing two triangles,
normals, texture coordinates and an embedded synthetic 2 by 2 PNG. Keep its
path, archive member name, API, configuration and skip-output behavior.
No drone images, datasets, runtime dependencies or packaging changes are needed.

Keep the generator in `tests/fixtures/textured-model.js`. Regenerate with
`bun tests/fixtures/textured-model.js`. Unit tests compare its output with the
committed fixture and check the scene, geometry and embedded resources.

The compatibility harness checks the downloaded GLB bytes against the fixture,
including in the skip-assets scenario. Its golden files stay unchanged. Only
the expected size of this archive member follows the corrected fixture rather
than the old five-byte placeholder. All other archive expectations stay fixed.

## Validation

Run `bun test tests/unit` and
`bun tests/compat/run.js --app . -- bun index.js`. The model tests must fail
with the original placeholder. Archive byte checks must fail on a changed
member even when its size stays the same. Run both archive implementations
when available. Keep skip-assets and custom-output coverage.

Use a disposable scratch machine for native-package and conforming-loader
diagnostics if CI cannot provide them. These do not replace CI evidence.
Test depth is unit because only fixtures, tests and documentation change.

The fix remains unreleased until a maintainer publishes it. Record the first
released native package containing the corrected fixture on #67 after release,
so dependent acceptance can pin that package. Do not claim that v2.6.1 has it.
