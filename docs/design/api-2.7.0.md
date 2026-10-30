# AIDM API 2.7.0: what the release ships and how it is proven

This note records the decisions of the grilling session of 30 October 2026 with the maintainer, the facts they rest on, and what the spec and the tickets take from it. It does not replace the spec. The words it uses are defined in `GLOSSARY.md`; the decisions that are hard to reverse have an ADR in `docs/adr/`.

## What 2.7.0 is

2.7.0 is the API half of AIDroneMap 0.2, one coordinated release with engine 0.2.0 (aidm #72) and the first aidm-ui tag. The three changelogs tell one story.

After 2.7.0 the API pauses new development. What is not in this release waits a long time, which is why the folder feature (#47) joins it.

No manifest has ever shipped. 2.7.0 is the first release aidm-ui can install from a signed manifest; 2.5.0 is covered by a built-in entry in aidm-ui, and 2.6.1 will be too.

Nothing in 2.7.0 changes an engine run, so no benchmark request is expected. A ticket that turns out to change task throughput files one at review clear and measures nothing.

## What master has today

Verified on 30 October 2026, master at fdc644b, no open pull requests.

- `package.json` says 2.6.1 and carries `"upstreamVersion": "NodeODX 2.4.0"`. `/info` returns it, and `engineUpstreamVersion` read from the engine's `UPSTREAM_VERSION` file (`libs/odmRunner.js`). Engine 0.2.0 no longer writes that file.
- The dependency cleanup (#66) landed: `uuid`, `mv`, `rimraf` and `request` are gone; `archiver` 8.0.0, `busboy` 1.6.0, `node-schedule` 2.1.2 and `systeminformation` 5.33.18 are pinned. `libs/storage.js` and `libs/taskNew.js` were rewritten; #8 and #47 build on that code.
- `## Unreleased` in `CHANGELOG.md` holds the eight dependency lines, one process line about the dry run, and the Entwine, `glob` and version-string fixes.
- `release.yml` has seven jobs: `check`, `executables`, `executables-test` (linux-x64, linux-arm64, windows-x64), `build` (cpu-amd64, cpu-arm64, gpu-amd64), `gpu-test` (environment `modal-gpu`), `manifest` (named "Tag images", publish runs only) and `release` ("Draft release", tag pushes only). A dry run is `workflow_dispatch` with `publish=false`; it pushes only the GPU image, untagged, to `ghcr.io/aidronemap/aidm-api-ci`. Assets go up with `gh release upload`; no third-party action is involved. The workflow signs nothing and reads no secret beyond the registry and Modal tokens.
- The images install `unzip` and `p7zip-full` themselves and run as root. The release archives ship no `apps/` folder; `libs/apps.js` looks for `apps/7z/7z.exe` and `apps/unzip/unzip.exe` next to the executable and otherwise uses `PATH`. `libs/ziputils.js` prefers `unzip` and falls back to `7z`; `all.zip` prefers `7z` and falls back to `archiver`.
- The server is Express on `app.listen(port)` with no host. There is no socket option and no `--host` flag.
- The API takes images only as uploads or as a `zipurl`. Every task init step runs after the 200 response, so a failure there becomes a FAILED task, not an error in the response.
- The compatibility harness runs eight scenarios in test mode against golden files and compares normalised JSON exactly. Four golden files record `/info` with `upstreamVersion`. The `zip-input` scenario extracts `seed.zip` and a `zipurl` download in test mode, with no engine.
- aidm-ui (main at a120b1a) parses `taskApiSocket` as an optional boolean on a container entry, verifies the raw bytes of `manifest.json` against a separate 64-byte `manifest.json.sig` with Ed25519 through WebCrypto, fetches both from `releases/latest/download/`, compares `sequence` as "strictly greater replaces", and compares `minimumUiVersion` against its own `package.json` version, 0.1.0. Its `/info` client reads no capability flag yet. ADR 0006 there fixes the socket path `/run/task-api.sock` and the config key `socket`; ADR 0007 fixes that the engine reads an imported folder through links.
- Engine 0.2.0 lists the images folder with a plain top-level directory listing, accepts `.jpg .jpeg .png .tif .tiff .bmp .raw .dng .nef .jxl` and the videos `.mp4 .mov .lrv .ts`, treats a `_mask` stem as a mask, and writes extracted frames, `frames.json`, subtitle files and generated masks into the images folder. It never modifies a photo.

## Decisions

### 1. The signed release manifest (#25, ADR 0001)

The manifest is one JSON file per release, `manifest.json`, with its raw Ed25519 signature in `manifest.json.sig`, both uploaded as release assets next to the archives and `SHA256SUMS`.

Content, in the schema aidm-ui parses:

- `schemaVersion` 1.
- `sequence` derived from the version: major x 1,000,000 + minor x 1,000 + patch. 2.7.0 carries 2007000. No counter is kept anywhere; tags are never redone, so the number only grows.
- `packageVersion` from `package.json`.
- `engineVersion` from the `FROM_REPO` tag in `Dockerfile` line 1, the line the `check` job already parses. 0.2.0 at the tag.
- `minimumUiVersion` from a new `minimumUiVersion` key in `package.json`, set to 0.1.0 for 2.7.0. It is the one place the value lives.
- `variants`: `linux-amd64-cpu`, `linux-arm64-cpu`, `linux-amd64-gpu`, all container entries with `kind`, `image` (no tag), `digest`, `size`, `gpu` and `taskApiSocket: true`. No native entries in 2.7.0.

Digests come from the `digest-*` artifacts the build jobs already upload (cpu-amd64, cpu-arm64, gpu-amd64). Size is the sum of the compressed layer sizes plus the config size of the platform manifest, read from the registry after the push with `docker buildx imagetools inspect <image>@<digest> --raw`. That is the rule aidm-ui's `server/manifest/builtin/README.md` states.

Where it is built. A Bun script in `scripts/` with three commands: build the manifest from the version, the engine version, the image name and the digest files; sign it with a PKCS#8 PEM private key read from standard input; verify a signature against a public key file. Signing and verification use WebCrypto, which Bun provides, so no dependency is added and no aidm-ui checkout happens at release time. The JSON is written once, with fixed formatting, and the signature covers exactly those bytes.

Jobs in `release.yml`:

- The current `manifest` job id becomes `tag-images`, so "manifest" names one thing.
- A new job builds `manifest.json` in every run, after the GPU test, and in a publish run after `tag-images`, so the digests it reads are the ones the tags point at. The builder must mind that a needed job skipped in a dry run skips its dependents unless the condition says otherwise.
- A tag-only job declared with `environment: release` reads `MANIFEST_SIGNING_KEY` by name, writes `manifest.json.sig`, and verifies that signature against the committed public key before anything is uploaded. A wrong or rotated secret fails the run. The environment's deployment rule allows only `v*` tags, so no other job may name it; a job that does, started from a branch, fails.
- In a dry run, a job with no environment generates a key inside the run, signs with it, verifies with the committed script, and uploads `manifest.json`, `manifest.json.sig` and the generated public key as one workflow artifact. The same job checks out `AIDroneMap/aidm-ui` at a commit pinned by full SHA, with the already pinned `actions/checkout`, and runs that checkout's `verifyManifest` from `server/manifest/verify.ts` with the generated key, so a manifest the UI would refuse fails the dry run. This runs in the dry run only.
- "Draft release" uploads `manifest.json` and `manifest.json.sig` with the other assets.

The public key is committed as one base64 line in `.github/manifest-public-key.txt`: `AyWaJGsLzH6SSwcX1BTMUG6Q4HN9KmMrJZeNHKIZNSI=`, the base64 of the 32 raw key bytes, the encoding aidm-ui's `keys.ts` uses.

Dry runs push all three images, untagged and by digest, to `ghcr.io/aidronemap/aidm-api-ci`, where today only the GPU image goes. The dry-run manifest then has three variants and names the package it read from. The rehearsal runs the same code as the tag run on every variant.

The maintainer created the `release` environment, its tag rule and the secret before this session. Agents never create, read, rotate or reference the private key and never touch environments or secrets.

### 2. The task API socket (#34)

Config key `socket`, flag `--socket <path>`, no default. With it set, the API listens on the path with a second `node:http` server on the same Express app, so every route and the token check are the same on both. The port keeps listening; no value turns it off. One `Bun.serve` cannot hold a port and a socket at once, which is why the second server is the design; Express on `node:http` supports a path.

Before listening, the API looks at the path. Nothing there: fine. A socket: removed, so a restart after a crash works. Anything else, a regular file or a directory: the start fails with an error naming the path. Removing a regular file at a mistyped path would destroy a user's file for a config typo.

The socket is created with mode 0600. The API runs as root in the image, and Apple's relay runs inside the container's own namespace, so it can open it; the Mac check below is what confirms that. On SIGTERM and SIGINT the existing graceful shutdown closes both servers and removes the socket file. The startup log gains a line such as "Server has started on socket /run/task-api.sock".

On Windows, `--socket` or a `socket` key stops the start with an error saying the option is not supported there. Bun documents sockets for `Bun.serve` and `fetch` but says nothing about Windows, where Node itself requires a `\\.\pipe\` name, and no client needs it: Docker and Podman keep the port.

The check that Apple's `--publish-socket` relay can open the socket cannot run in CI or on a scratch machine. The maintainer runs it on his Mac with an arm64 CPU image from a dry run that includes both the socket code and the three-image push, which is any dry run after #34 and #25 are merged, or the release rehearsal:

```
container run --rm --name api-socket-check \
  --publish-socket "$HOME/task-api.sock:/run/task-api.sock" \
  ghcr.io/aidronemap/aidm-api-ci@sha256:<cpu-arm64 digest from the dry run> \
  --test --socket /run/task-api.sock
curl --unix-socket "$HOME/task-api.sock" http://localhost/info
```

An answer with the JSON of `/info` is a pass. A refused connection or a permission error is the socket mode or the relay's user, and comes back to this spec.

### 3. A task from a folder the API can read (#47, ADR 0002)

The field is `imagesPath`, a form field accepted at `POST /task/new/init` and `POST /task/new`. `GET /info` says `"imagesPath": true` when the feature is on and has no `imagesPath` key at all when it is off, so the golden files that record `/info` do not change.

The feature is off until the API is started with `--images_root <folder>` (config key `imagesRoot`). A request's `imagesPath` must resolve, through real paths, to a folder inside the root; anything else is refused. Without a root, any client that reaches the API could point a task at any folder the API user can read, and the `outputs` option already lets a client fetch files from inside the task folder. The UI writes the API's config file for the engine it manages and mounts an imported folder itself, so it sets the root; an operator with an engine at a loopback address sets it once.

Which files. From the folder itself, not its subfolders, every regular file whose extension is in the engine's image list (`.jpg .jpeg .png .tif .tiff .bmp .raw .dng .nef .jxl`) or video list (`.mp4 .mov .lrv .ts`), matched without case. Mask files are in by construction, since they carry an image extension. The list is hard-coded in the API, because test mode has no engine; it is the engine 0.2.0 list from `modules/context.py`.

When the checks run. The root check, the readability check and "at least one accepted file" run before the response of `/task/new/init` and `/task/new`, and fail it with an error in the response, the way the API reports errors today. The links are made at the same point, into the task's staging folder where uploads land, so a link that cannot be made also fails the response; commit then moves them with the uploads, as it moves uploads today, and the moved links satisfy the "Need at least 1 file." count. `imagesPath` together with `zipurl` is refused. Uploaded files alongside `imagesPath` stay allowed and land where they do today, so a client can upload a ground control file next to a linked folder.

Error texts the spec fixes (the exact strings are the spec's to settle, the cases are these): the feature is not enabled; the path is outside the images root; the path cannot be read, with the reason; the folder holds no supported image or video file; `imagesPath` and `zipurl` cannot both be set.

How a link is made. For each file the API tries a hard link into the images folder and, when that fails (another file system, a read-only mount, Windows without the right), a symbolic link whose target is the absolute real path of the source file. A hard link survives the source being moved during a run; a symbolic link does not, which is why it is the fallback. Absolute targets keep a link valid wherever the task folder is read from. The engine lists the images folder with a plain directory listing and opens each file by path, so a link is a file to it.

In a container the source is a read-only mount, a hard link across the mount boundary fails, and the symbolic link is the normal case. The engine runs in the same container and resolves the same path. No restriction on where a link points is needed beyond the root: inside the root, the target is where the operator put the photos.

The source folder is never written. The API opens nothing there for writing, and the engine writes its frames, frames list, subtitle files and masks into the images folder, where they land next to the links. Removing a task removes its folder, which removes the link entries and never the targets. A restart reuses the images folder, links included, and needs nothing new.

Docs: `docs/swagger.json` and `docs/index.adoc` gain the field and the capability.

### 4. The bundled tools (#8, ADR 0003)

Every release archive bundles one 7-Zip executable and no Info-ZIP `unzip`. 7-Zip handles both extraction and `all.zip`. On the scratch machine, 7-Zip alone passed the compatibility scenarios against the golden files, `seed.zip` with full paths and the `zipurl` download flattened, with one error string as the only difference. Info-ZIP `unzip` 6.0 is from 2009, has no official Windows x64 build, and distributions carry fixes its source lacks.

Which binaries. Official 7-Zip 26.05 from its GitHub releases, pinned by SHA-256 in `scripts/7zip-sha256sums.txt` next to the Bun sums:

- Windows x64: `x64/7za.exe` from `7z2605-extra.7z`. No RAR code, so LGPL plus BSD parts only.
- Linux x64 and arm64: the static `7zzs` from `7z2605-linux-x64.tar.xz` and `7z2605-linux-arm64.tar.xz`. These include the RAR reader and carry the unRAR restriction, which forbids using that code to recreate RAR compression and asks that the licence text travel with the binary.
- macOS: `7z2605-mac.tar.xz` exists for the day #24 lands. Not in 2.7.0.

A pinned, checksummed download is the pattern `scripts/get-bun.sh` sets, and it needs no compiler in the release job. A source build with `DISABLE_RAR=1` was tried on the scratch machine and works in seconds on x64; it was not chosen, because arm64 would need a cross-compiler or a new job on the arm runner.

A new `scripts/get-7zip.sh <platform> <dest>` downloads, verifies and unpacks; it uses the Linux `7zzs` it just fetched to open the Windows Extra package, so the build runner needs no 7-Zip of its own. `scripts/package.sh` places the tool at `apps/7z/7zzs` (Linux) or `apps/7z/7za.exe` (Windows) in the archive, and the notices generator takes each package's own `License.txt` from the downloaded package, so the licence in `THIRD-PARTY-NOTICES.txt` is from the exact pinned build.

Lookup order. In a compiled executable `libs/apps.js` looks for the bundled 7-Zip next to the executable first and uses it for both extraction and `all.zip`. `PATH` lookup (`unzip`, then `7z`) stays as the fallback, and as the whole rule in source mode and in the images, which install both tools and ship no `apps/` folder. An archive that prefers its own tool behaves the same on every machine.

The one golden difference. When a `zipurl` download is not a zip, `unzip` exits 9 and every 7-Zip build exits 2, so the executable with its bundled tool reports "7z exited with code 2" where `tests/compat/golden/zip-input.json` holds "unzip exited with code 9". The harness treats those two strings as the same for that step. The golden file stays unchanged and the message existing clients see does not move.

CI. In `executables-test`, each platform runs the harness on the compiled executable with `unzip` and `7z` removed from `PATH`, so the bundled tool is the only one and `zip-input` runs on Windows for the first time; a second run with the `apps/` folder removed keeps `zip-input-no-tools` honest. These replace today's "without 7z" and "Windows without tools" steps. `README.md` lines about installing the tools are rewritten: the archives bundle 7-Zip, the images install both, source mode needs them on `PATH`.

### 5. The upstream fields leave `/info` (#69, ADR 0004)

`upstreamVersion` and `engineUpstreamVersion` leave `/info`, the startup log, `docs/swagger.json`, `docs/index.adoc`, the four golden files that record `/info` (`default`, `limits`, `token`, `zip-input-no-tools`), `tests/unit/systeminformation.test.js` and `package.json`. `getUpstreamVersion` in `libs/odmRunner.js` and its wrapper in `libs/odmInfo.js` go. `README.md` lines 5 and 121 to 123 are rewritten to describe the contract without a NodeODX version: "compatible with the NodeODM task API" stays, a version does not.

This removes two fields from a response, which `AGENTS.md` allows only with an approved spec. The spec of this release is that spec, and the changelog line calls the removal out. The reason: `engineUpstreamVersion` has no source once the engine stops writing `UPSTREAM_VERSION`, and `upstreamVersion` states a tracking relation to a reference project that `AGENTS.md` says does not exist.

The issue is #69, opened in this session.

### 6. The release ticket

The last ticket of 2.7.0. It is blocked by the engine tag `v0.2.0` and by every other 2.7.0 ticket.

- Every file the version test checks says 2.7.0: `package.json`, `Dockerfile`, `Dockerfile.gpu`, `apptainer.def`, `docs/swagger.json`, `docs/index.adoc`, `README.md` (status line and image tags), `CHANGELOG.md`, `tests/compat/README.md`.
- `Dockerfile` and `apptainer.def` move the base to `ghcr.io/aidronemap/aidm:0.2.0`, `Dockerfile.gpu` to `0.2.0-gpu`. That bump is what makes #39 true: the GPU test's dataset and checks come from the engine image.
- `## Unreleased` becomes `## 2.7.0`. The eight dependency lines and the process line are rewritten into lines a user can read: what changed, where the evidence is, no review-record numbers. A paragraph at the top tells the release as a whole: engine 0.2.0, the first UI tag, the signed manifest, the socket, the folder path, the bundled tool, and the two upstream fields removed. "Draft release" takes the notes from that section.
- The dry run on the final branch is the rehearsal of the tag run.

Tag order. The API tags `v2.7.0` as soon as `v0.2.0` exists and every 2.7.0 ticket is merged, without waiting for the UI tag. The aidm-ui session then pins the published digests and the manifest. The announcement of AIDroneMap 0.2 waits for all three tags. After publishing, the maintainer re-pins aidronemap.dev to `v2.7.0`.

## Test seams and test depth per ticket

| Ticket | Seams | Depth |
| --- | --- | --- |
| #69 upstream fields removal | The four golden files updated in the same pull request; `tests/unit/systeminformation.test.js` and `version-strings` pass; the harness passes. | `full` (`package.json`) |
| #25 manifest | Unit tests for the script: sequence rule, size rule from a stored platform manifest, byte-exact output, sign and verify round trip, verify fails on a wrong key. The dry run proves the jobs: three-variant manifest, aidm-ui's verifier accepts it, artifact present. | `full` |
| #34 socket | A unit test starts the API in test mode with `--socket` in a child process and calls `/info` over the socket; stale socket and wrong-file cases; Windows refusal. One `socket` scenario in the harness whose requests all go through the socket and whose golden file must match the `default` steps for the same routes, skipped on Windows. | `unit` |
| #47 folder | A unit test starts the API with `--images_root` on a temporary folder of small files, creates a task through the chunked route, checks the images folder holds links, the source files, sizes and modification times are unchanged after the task completes, and the links go with the task. Unit tests for the refusals (no root, outside the root, unreadable, empty, with `zipurl`). One `images-path` scenario with its own golden file: `/info` with the capability and a task from a folder under `tests/`. | `full` |
| #8 tools | Unit tests for `get-7zip.sh` (checksum mismatch fails) and for the lookup order in `libs/apps.js`; the harness equivalence of the two corrupt-zip messages. The dry run runs the harness on each executable with no `PATH` tools and with no `apps/` folder, Windows included. | `full` |
| Release ticket | The version test; the harness; the dry run on the final branch as the rehearsal. | `full` |

## Dry-run budget

Five `full` tickets (#69, #25, #8, #47, the release ticket), five maintainer-started exact-head dry runs at minimum, one per pull request, each after its review loop clears and before merge. A second per ticket only if the head moves after the dry run. At most three run in parallel in the repository.

Order: #69 first, since it changes the `/info` golden steps every later scenario copies; then #25 and #8 in sequence, since both edit `release.yml`; #47 and #34 whenever ready; the release ticket last.

Before the first dry run the maintainer checks that the `modal-gpu` environment's branch policy covers every builder branch prefix (`feat/`, `fix/`, `docs/`, `chore/`, `ci/`, `test/`).

## What the aidm-ui session reads from here

- `sequence` rule: major x 1,000,000 + minor x 1,000 + patch. 2.7.0 is 2007000, above the built-ins at 1 (2.5.0) and 2 (2.6.1).
- `minimumUiVersion` of 2.7.0: 0.1.0.
- `taskApiSocket: true` on each of the three container variants of 2.7.0; the key sits on the variant entry, as the UI's schema already reads it.
- The API's socket config key is `socket`; the UI writes `"socket": "/run/task-api.sock"` and keeps `port`.
- The folder field is `imagesPath` at `POST /task/new/init` and `POST /task/new`; the capability in `GET /info` is `"imagesPath": true`, absent when off. The API accepts the field only under `--images_root`, so the UI's engine manager sets `imagesRoot` in the config file it writes and mounts imported folders under that root.
- The release public key is one base64 line in `.github/manifest-public-key.txt` in aidm-api; the value is `AyWaJGsLzH6SSwcX1BTMUG6Q4HN9KmMrJZeNHKIZNSI=`.
- Manifest assets are `manifest.json` and `manifest.json.sig` on the `v2.7.0` release.

## Out of scope, recorded so the spec can say so

- #24 macOS executable: needs aidm #15.
- #15 API quirks (errors as HTTP 200, other uploaded zips deleted): contract changes that need the maintainer's decision, not this release.
- #12 `contrib/`, #13 dev tooling.
- #67 test-mode GLB placeholder: being fixed on its own; a test fixture, not a feature. No pull request existed on 30 October.
- The Modal GPU test on every master push: the surviving part of the closed #40, a later `release.yml`-only pull request when aidm-bench needs API images for master.
- The lint job and `ci-paths.yml`: after the tag, as in the engine.
- Any dispatch, scheduling or multi-machine work: the connector repository, which does not exist yet.

## What the maintainer does

1. Before the first dry run: check the `modal-gpu` environment's branch policy covers every builder branch prefix.
2. Start each dry run when a ticket's review loop clears; five at minimum, in the order above.
3. After #34 and #25 are merged, run the `--publish-socket` check on his Mac with the command in decision 2, on a dry-run arm64 image.
4. After the engine tag `v0.2.0`: merge the release ticket after its rehearsal, push `v2.7.0`, and publish the draft release when the tag run is green.
5. Re-pin aidronemap.dev to `v2.7.0`.

Nothing here needs a new secret, environment or repository setting.
