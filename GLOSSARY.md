# AIDM API

The task API of the AIDM engine. This glossary fixes the words the docs, specs and pull requests of the task API use for how it is released, tested and fed with images.

## Language

### Release and manifest

**Release manifest**:
The signed JSON file a release publishes to say which engine packages exist, and what their digests and sizes are.
_Avoid_: Image manifest, index, catalogue, feed

**Image manifest**:
The registry's description of one platform image. The release manifest reads sizes from it.
_Avoid_: Platform manifest (when the registry term is meant)

**Image index**:
The registry's list of the platform manifests behind one tag.
_Avoid_: Multi-platform manifest

**Variant**:
One installable package of a release, named by its platform and by whether it needs a GPU.
_Avoid_: Flavour, target

**Sequence number**:
The number in a release manifest that only grows. It is derived from the version, and a client uses it to refuse an older manifest.
_Avoid_: Version counter

**Signing key**:
The Ed25519 key pair whose private half signs release manifests from the release environment. The public half is committed to the repository.
_Avoid_: Release key, certificate

**Dry run**:
A run of the release workflow started by hand on a branch with publish off. It builds the executables and images, runs the harness and the GPU test, signs with a key made in the run and publishes nothing; it is how the `full` test depth runs.

**Tag run**:
The run of the release workflow started by a version tag. It builds, tests, signs with the signing key and drafts the release.

**Release environment**:
The environment of the repository that holds the signing key and admits only version tags.
_Avoid_: Deployment, protected environment

### Tools and archives

**Bundled tool**:
An executable shipped inside a release archive next to the API, so that nothing on the operator's PATH is needed.
_Avoid_: Dependency, helper binary

**Release archive**:
The per-platform archive of a release. It holds the executable, the bundled tool and the files the API serves.
_Avoid_: Bundle; package (when the engine package is not meant)

**Third-party notices**:
The file in a release archive that carries the licence text of every bundled tool and dependency.

### Ways into a task

**Images path**:
A folder on the API's machine that a task is created from. A request names it at creation, and the engine reads it in place.
_Avoid_: Source folder, import path

**Images root**:
The one folder, set at startup with `--images_root`, under which an images path may lie. The feature is off without it.

**Images folder**:
The folder inside a task where the engine reads images and writes frames, a frames list and masks.
_Avoid_: Dataset folder

**Link**:
An entry in the images folder that points at a file of the images path. It is a hard link where the file system allows it and a symbolic link otherwise.
_Avoid_: Shortcut, alias, copy

**Zip address**:
The `zipurl` way in: the address of a zip file that the API fetches itself.
_Avoid_: Link, remote dataset

**Upload**:
Images sent in the body of the request.

### Reaching the API

**Task API socket**:
The Unix socket path the API listens on next to its port, for a client on the same machine or a container relay.
_Avoid_: Pipe, IPC endpoint

**Capability**:
A key with the value true in the info response that says the API has an optional feature. When the key is absent, the feature is not available.

### Testing

**Test mode**:
The API started with `--test`, which simulates the engine with sample outputs. Uploads and zip addresses are still extracted.

**Compatibility harness**:
The runner under `tests/compat/` that drives the API through scenarios and compares each response with a golden file.

**Scenario**:
One named start of the API, with its flags and the requests the harness sends it.

**Golden file**:
The recorded, normalised responses of one scenario, which the harness compares against. It changes only when the contract changes, and the change is called out.

**Test depth**:
The declaration in a pull request of which test runs the changed code: `unit` or `full`.
