# AIDM API

**The task API of the [AIDM](https://github.com/AIDroneMap/aidm) photogrammetry engine, part of [AIDroneMap](https://github.com/AIDroneMap).**

AIDM API is a REST server that accepts drone images, runs the AIDM engine on them, and returns the results. It is forked from [NodeODX](https://github.com/WebODM/NodeODX) and keeps the same API, so clients such as [WebODM](https://github.com/WebODM/WebODM), PyODX and CloudODX can connect to it without changes.

> **Status: 2.6.1.** AIDM API 2.6.1 runs on Bun and ships as one executable, on top of the AIDM 0.1.0 engine. The [changelog](CHANGELOG.md) lists what changed.

Documentation is at [aidronemap.dev](https://aidronemap.dev): [running the API](https://aidronemap.dev/api/running/), [configuration](https://aidronemap.dev/api/configuration/), the [API reference](https://aidronemap.dev/api/reference/) and [clients](https://aidronemap.dev/api/clients/). News is on [aidronemap.org](https://aidronemap.org).

## Where it fits

AIDroneMap has three separate parts:

| Part | Repository | Role |
| --- | --- | --- |
| Engine | [aidm](https://github.com/AIDroneMap/aidm) | Turns images into maps and models |
| Task API | this repository | Runs the engine on one machine and exposes it over HTTP |
| Cloud layer | coming later | Spreads jobs across many machines and cloud providers |

The engine and this API ship together in one container image. Scheduling across machines is not part of this repository.

## Quick start

```
docker run -p 3000:3000 ghcr.io/aidronemap/aidm-api:2.6.1
```

Open http://127.0.0.1:3000, add some images and press **Start Task**.

### GPU

With an NVIDIA GPU and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html):

```
docker run -p 3000:3000 --gpus all ghcr.io/aidronemap/aidm-api:2.6.1-gpu
```

### Build from source

Build the engine first, then this API on top of it:

```
git clone https://github.com/AIDroneMap/aidm.git
git clone https://github.com/AIDroneMap/aidm-api.git

docker build -t aidm aidm
docker build --build-arg FROM_REPO=aidm -t aidm-api aidm-api

docker build -f aidm/gpu.Dockerfile -t aidm:gpu aidm
docker build -f aidm-api/Dockerfile.gpu --build-arg FROM_REPO=aidm:gpu -t aidm-api:gpu aidm-api
```

### Run from source

You need [Bun](https://bun.sh). The version is in `.bun-version`.

```
bun install
bun index.js --test
```

Drop `--test` to use a real engine. Test mode simulates the engine with the sample outputs in `tests/`.

### Build the executable

```
bun install --frozen-lockfile --production
scripts/build.sh dist/aidm-api
```

The result is one executable with no runtime to install. It needs these files next to it: `config-default.json`, `public/`, `helpers/`, `scripts/` and `docs/swagger.json`, plus `tests/` for test mode. The working directory must contain `tmp/` and `data/`, because the API writes there. A compiled executable does not read `.env` or `bunfig.toml`. On x64 it needs a CPU with SSE4.2 (Nehalem, 2008 or newer).

### Release archives

Each release has an archive for Linux x64, Linux arm64 and Windows x64: `aidm-api-<version>-linux-x64.tar.gz`, `aidm-api-<version>-linux-arm64.tar.gz` and `aidm-api-<version>-windows-x64.zip`. `SHA256SUMS` lists their checksums.

An archive has one folder with the executable (`aidm-api`, or `aidm-api.exe` on Windows), `config-default.json`, `public/`, `helpers/`, `scripts/postprocess.sh`, `docs/swagger.json`, the sample outputs in `tests/`, empty `tmp/` and `data/` folders, `LICENSE`, `SOURCE`, `THIRD-PARTY-NOTICES.txt` and 7-Zip in `apps/7z/`. The notices file has the licences of Bun, of every npm package inside the executable and of the bundled 7-Zip.

Unpack it, then start it from that folder. You need an installed AIDM engine:

```
tar xzf aidm-api-<version>-linux-x64.tar.gz
cd aidm-api-<version>-linux-x64
./aidm-api --odx_path /path/to/aidm
```

The archives bundle 7-Zip. The executable uses it to extract zip files (uploads and `zipurl`) and to build `all.zip`, so you install no zip tool. The images install both `unzip` and `7z`. To run from source, install `unzip` and `7z` and put them on the `PATH`. Without them, tasks with zip files fail with an error. Without `7z`, the API builds `all.zip` with a slower JavaScript fallback.

On Windows, only test mode works today, because there is no Windows engine: run `aidm-api.exe --test`.

To build an archive yourself, run `bun install --frozen-lockfile --production`, then `scripts/package.sh linux-x64 dist`. The script downloads the 7-Zip build pinned in `scripts/7zip-sha256sums.txt`.

### Keeping results

Results are stored in `/var/www/data` inside the container. Mount a folder there to keep them:

```
docker run -p 3000:3000 -v /path/to/storage:/var/www/data ghcr.io/aidronemap/aidm-api:2.6.1
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
| `--images_root` | Folder under which a task can be created from a folder of photos with `imagesPath`, through links instead of copies. Without it, `imagesPath` is refused |

Run `docker run --rm ghcr.io/aidronemap/aidm-api:2.6.1 --help` for the full list, and see `config-default.json` for the file format. [Configuration](https://aidronemap.dev/api/configuration/) describes every flag.

## API

The [API reference](https://aidronemap.dev/api/reference/) documents every endpoint. The specification files in this repository are [docs/swagger.json](docs/swagger.json) and [docs/index.adoc](docs/index.adoc). It is compatible with the NodeODM task API. [MIGRATION.md](MIGRATION.md) lists the changes from 1.x.

The API version follows semantic versioning. The AIDM 0.1.0 release ships engine 0.1.0 with API 2.5.0. The API version stays at or above 2.4.0, because PyODX and WebODM read it from `GET /info` and switch to older code paths below certain versions.

Any change to the API must stay compatible: new fields and endpoints may be added, existing ones are not renamed or removed.

## Planned changes

Each item will be added in a compatible way, without breaking existing clients:

- **Structured progress:** progress events per processing stage, instead of a single percentage.
- **Result manifest:** a clear status for every output file.
- **Resources known in advance:** an estimate of memory, CPU and time before a task starts.
- **S3-compatible storage for task inputs and intermediate stages.** Finished results can already be uploaded to S3 today (see `--s3_endpoint` in `--help`).

## Contributing

Contributions are welcome. Read the [contributing guide](https://github.com/AIDroneMap/.github/blob/main/CONTRIBUTING.md) first. Every commit needs a DCO sign-off (`git commit -s`).

## Licence

AIDM API is licensed under the [GNU Affero General Public License v3.0](LICENSE), the same licence as NodeODX. If you run a modified version as a network service, you must offer its source code to the users of that service. The [SOURCE](SOURCE) file says where to find it.

Copyright notices from NodeODX, NodeODM and their contributors are kept as they are.

## Credits

AIDM API exists thanks to [NodeODX](https://github.com/WebODM/NodeODX) by the [WebODM](https://github.com/WebODM) maintainers, which continues [NodeODM](https://github.com/OpenDroneMap/NodeODM) from [OpenDroneMap](https://github.com/OpenDroneMap).

AIDM API is an independent project. It is not affiliated with or endorsed by WebODM or OpenDroneMap.

AIDroneMap is maintained by [Dimitri Albino](https://github.com/DimitriAlbino) and sponsored by [ITALDRONI](https://italdroni.it).
