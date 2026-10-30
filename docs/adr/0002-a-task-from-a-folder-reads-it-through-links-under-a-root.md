# ADR 0002: A task from a folder reads it through links under a root

Status: accepted, October 2026

## Context

aidm-ui keeps the photos on the server and lets the engine read an imported folder in place (its ADR 0007). Until now the API took images only as uploads or as a zip address.

Three facts shape the design. The engine writes frames, a frames list, subtitle files and masks into its images folder. The API runs as root in the image and, by default, without a token. The `outputs` option already lets a client fetch files from inside the task folder.

## Decision

A request names the folder in `imagesPath`, at task creation. The API makes a link in the task's images folder for each accepted file: a hard link first, an absolute symbolic link when that fails. The folder checks and the links happen before the response, so a failure is an error in the response.

The feature works only under a folder set with `--images_root`. The info response carries the capability key `imagesPath` when the feature is on, and no such key when it is off.

The accepted files are the top-level files with an extension from the engine 0.2.0 lists. The lists are hard-coded in the API, because test mode has no engine. `imagesPath` cannot be combined with a zip address.

Considered and rejected:

- Mounting the folder as the images folder. The engine writes there.
- Copying. It doubles a flight on one disk.
- Symbolic links only. A moved source breaks a run, while a hard link survives it.
- Always on, without a root. Any client could read any folder the API user can read.
- `"imagesPath": false` when off. It would change every golden file that records the info response.

## Consequences

- A hard link shares the file with the source. The guarantee that the source is never written rests on the engine opening photos read-only, which it does today.
- In a container the source is a read-only mount, so the symbolic link is the normal case.
- Removing a task removes the links and never their targets.
- The UI's engine manager sets the root and mounts imported folders under it.
- The extension lists must follow the engine's when they change.
