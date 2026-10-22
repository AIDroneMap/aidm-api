# AIDM API

**The task API of the [AIDM](https://github.com/AIDroneMap/aidm) photogrammetry engine, part of [AIDroneMap](https://github.com/AIDroneMap).**

AIDM API is a REST server that accepts drone images, runs the AIDM engine on them, and returns the results. It is forked from [NodeODX](https://github.com/WebODM/NodeODX) and keeps the same API, so clients such as [WebODM](https://github.com/WebODM/WebODM), PyODX and CloudODX can connect to it without changes.

> **Status: just forked, no release yet.** This repository currently matches NodeODX 2.4.0. Until the first AIDM release, use [NodeODX](https://github.com/WebODM/NodeODX) for production work.

## Where it fits

AIDroneMap has three separate parts:

| Part | Repository | Role |
| --- | --- | --- |
| Engine | [aidm](https://github.com/AIDroneMap/aidm) | Turns images into maps and models |
| Task API | this repository | Runs the engine on one machine and exposes it over HTTP |
| Cloud layer | coming later | Spreads jobs across many machines and cloud providers |

The engine and this API ship together in one container image. Scheduling across machines is not part of this repository.

## Quick start

Prebuilt images are not published yet, so build the engine first and then this API on top of it.

```
git clone https://github.com/AIDroneMap/aidm.git
git clone https://github.com/AIDroneMap/aidm-api.git

docker build -t aidm aidm
docker build --build-arg FROM_REPO=aidm -t aidm-api aidm-api

docker run -p 3000:3000 aidm-api
```

Open http://127.0.0.1:3000, add some images and press **Start Task**.

### GPU

With an NVIDIA GPU and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html):

```
docker build -f aidm/gpu.Dockerfile -t aidm:gpu aidm
docker build -f aidm-api/Dockerfile.gpu --build-arg FROM_REPO=aidm:gpu -t aidm-api:gpu aidm-api

docker run -p 3000:3000 --gpus all aidm-api:gpu
```

### Keeping results

Results are stored in `/var/www/data` inside the container. Mount a folder there to keep them:

```
docker run -p 3000:3000 -v /path/to/storage:/var/www/data aidm-api
```

## Configuration

Settings are passed as command-line flags after the image name, or in a JSON file with `--config`. Command-line flags take precedence. Useful ones:

| Flag | Purpose |
| --- | --- |
| `--port` | Port to listen on (default 3000) |
| `--token` | Require this token on every request |
| `--max_images` | Reject tasks with more images than this |
| `--parallel_queue_processing` | How many tasks run at the same time |
| `--cleanup_tasks_after` | Minutes after which finished tasks are deleted |
| `--webhook` | URL called when a task completes |
| `--s3_endpoint`, `--s3_bucket` | Upload finished results to S3-compatible storage |
| `--test` | Test mode: simulates the engine, for development without it |

Run `docker run --rm aidm-api --help` for the full list, and see `config-default.json` for the file format.

## API

The API specification is in [docs/index.adoc](docs/index.adoc), with a Swagger file in [docs/swagger.json](docs/swagger.json). It is the same as NodeODX API 2.x. [MIGRATION.md](MIGRATION.md) lists the changes from 1.x.

Any change to the API must stay compatible: new fields and endpoints may be added, existing ones are not renamed or removed.

## Planned changes

Each item will be added in a compatible way, without breaking existing clients:

- **Structured progress:** progress events per processing stage, instead of a single percentage.
- **Result manifest:** a clear status for every output file.
- **Resources known in advance:** an estimate of memory, CPU and time before a task starts.
- **S3-compatible storage for task inputs and intermediate stages.** Finished results can already be uploaded to S3 today (see `--s3_endpoint` in `--help`).
- **A maintained runtime:** the image currently uses Node.js 14, which no longer receives security updates.

## Contributing

Contributions are welcome. Read the [contributing guide](https://github.com/AIDroneMap/.github/blob/main/CONTRIBUTING.md) first. Every commit needs a DCO sign-off (`git commit -s`).

## Licence

AIDM API is licensed under the [GNU Affero General Public License v3.0](LICENSE), the same licence as NodeODX. If you run a modified version as a network service, you must offer its source code to the users of that service. The [SOURCE](SOURCE) file says where to find it.

Copyright notices from NodeODX, NodeODM and their contributors are kept as they are.

## Credits

AIDM API exists thanks to [NodeODX](https://github.com/WebODM/NodeODX) by the [WebODM](https://github.com/WebODM) maintainers, which continues [NodeODM](https://github.com/OpenDroneMap/NodeODM) from [OpenDroneMap](https://github.com/OpenDroneMap).

AIDM API is an independent project. It is not affiliated with or endorsed by WebODM or OpenDroneMap.

AIDroneMap is maintained by [Dimitri Albino](https://github.com/DimitriAlbino) and sponsored by [ITALDRONI](https://italdroni.it).
