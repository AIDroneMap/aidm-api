# ADR 0004: The upstream fields leave the info response

Status: accepted, October 2026

## Context

The info response carries `upstreamVersion` and `engineUpstreamVersion`. The startup log prints them, and `package.json` holds the first. The second is read from a file the engine wrote, and engine 0.2.0 no longer writes that file. From 2.7.0 it has no source at all.

The first field has a different problem. It states a tracking relation to a reference project, and `AGENTS.md` says no such relation exists. The same file says existing fields are never removed without an approved spec.

Removing a field from a response is a break for any client that reads it, so the choice needs a record.

## Decision

Both fields leave the response, the startup log, the docs, the golden files and `package.json`, in one pull request. The code that read the engine's file goes with them, and so do the lines of the unit tests and the README that mention them.

The 2.7.0 spec is the approved spec, and the changelog calls the removal out.

"Compatible with the NodeODM task API" stays as the description of the contract. It names no version.

Considered and rejected:

- Keeping `engineUpstreamVersion` as a permanent "?". It would be a field with no source.
- Keeping `upstreamVersion` as a frozen string. It would state a tracking relation that does not exist.

## Consequences

- The four golden files that record the info response change in that pull request and in no other.
- A client that read the fields sees them gone.
- Later scenarios copy the info steps from the updated golden files, so this pull request lands first.
- The API describes itself by what it is.
