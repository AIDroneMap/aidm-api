# ADR 0001: The release manifest is signed in the tag run

Status: accepted, October 2026

## Context

aidm-ui installs an engine from a release manifest. Its ADR 0003 fixes how it trusts one: a raw Ed25519 signature over the exact bytes of the file, a public key built into the UI, and a refusal of any manifest whose sequence is older than the one it holds.

The release workflow had no signing step and read no signing secret. The maintainer has since created the release environment, with a rule that admits only version tags, and put the signing key in it.

## Decision

The sequence number is derived from the version: major x 1,000,000 + minor x 1,000 + patch. Version 2.7.0 is 2007000. `minimumUiVersion` comes from one key in `package.json`.

A Bun script in this repository builds, signs and verifies the manifest with WebCrypto. No dependency is added.

Every run builds the manifest. Only a tag-only job that names the release environment signs it, and that job verifies the signature against the committed public key before anything is uploaded. Digests come from the build jobs. Sizes come from the registry.

A dry run signs with a key made in the run. It pushes all three images, untagged, to the CI package, and it checks the manifest with aidm-ui's own verifier at a pinned commit.

Considered and rejected:

- A counter kept in the repository for the sequence. It is state that can drift. Tags are never redone, so the version is enough.
- Checking out aidm-ui in the tag run. The tag run stays self-contained.
- An environment reference on the building job. A branch run would fail the deployment rule.
- Signing in the dry run with the real key. The secret would leave the release environment.

## Consequences

- A wrong or rotated secret fails the tag run instead of publishing.
- The rehearsal manifest names the CI package, not the release package.
- The old `manifest` job is renamed `tag-images`, so "manifest" names one thing.
- The UI session copies the public key value from this repository.
- Agents never create, read, rotate or reference the private key.
