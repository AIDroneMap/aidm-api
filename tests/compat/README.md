# Compatibility tests

These tests check that the API answers the same way on every runtime (Node.js 14, Bun, a compiled Bun executable). They start the API in `--test` mode, call every endpoint in `docs/swagger.json`, and compare the responses with golden files.

The harness is plain CommonJS with no dependencies. It runs unchanged on Node.js 14 and on Bun. The golden files were recorded with Node.js 14.21.3, the runtime of AIDM API 2.5.0.

The GLB fixture was corrected in #67. Its expected archive member size follows
the fixture instead of the old placeholder size in the golden files. The
harness also extracts that member and checks its bytes against the fixture,
even when ZIP listings are not compared because `7z` is missing. Default,
token and skip-assets tasks must include it. Skip-assets exclusions are checked
with either archive implementation. All other golden expectations stay fixed.

## Run

```
bun tests/compat/run.js --app <dir> [--update] [--only <scenario>] [--keep] -- <command> [args...]
```

- `--app <dir>`: the folder that holds the runnable API. Today that is the repository root. Later it can be an unpacked release archive with a compiled executable.
- `<command> [args...]`: how to start the API, for example `bun index.js` or `./aidm-api` (or `aidm-api.exe`). If the first element is a relative path that exists inside the app copy, the harness uses that file. The harness adds `--test --port <free port>` and the flags of the scenario.
- `--update`: write the golden files instead of comparing. Record them only with both `unzip` and `7z` on PATH (the harness refuses otherwise). The exceptions are `--only zip-input-no-tools` and `--only images-path`, which can be recorded on any machine.
- `--only <scenario>`: run one scenario.
- `--keep`: keep the temporary copy of the app (for debugging).

Examples:

```
bun install --frozen-lockfile --production
bun run test:compat
bun tests/compat/run.js --app ./dist/aidm-api-2.6.1-linux-x64 -- ./aidm-api
```

To check the original runtime, run it with Node.js 14 and `-- node index.js`, after `npm install --production`.

The exit code is 0 when every scenario passes and 1 when any step differs or a scenario fails. A failing step prints a unified diff of the normalised JSON (expected against actual). A failing scenario also prints the last 50 lines of the server output.

## How it works

For each scenario the harness:

1. Copies `--app` into a fresh temporary directory. It skips `.git`, and at the top level `node_modules`, `tmp`, `data` and `.worktrees`. It copies `tests/data` as an empty folder with only its `.gitignore`. If `<dir>/node_modules` exists it is linked into the copy (a `junction` on Windows). It creates an empty `tmp/`. The source tree is never changed.
2. Starts the command in that copy and polls `GET /info` until the server answers (30 s limit). The `socket` scenarios add `--socket <copy>/api.sock`, and every request, this one included, goes through the socket.
3. Runs the steps in a fixed order and waits for every task to reach a final status (30, 40 or 50) before any step that depends on it.
4. Stops the server and deletes the copy. Scenarios run one after another because the API always binds UDP port 6367.

The harness also starts two small servers on 127.0.0.1: one serves test zip files (for `zipurl`), one receives webhook calls.

Test images and zip files are generated at run time from seeded random bytes. Nothing binary is committed. The API does not decode images in test mode.

## Scenarios

| Scenario | Flags | What it covers |
| --- | --- | --- |
| `default` | none | All routes, success and error cases: static files, `/info`, `/options`, auth stubs, `/task/new` (options, outputs, `set-uuid`, GCP file, errors, `zipurl` failures), chunked upload (`init`, `upload`, `commit`), task info and output, `all.zip` download, cancel, restart, remove (urlencoded and JSON bodies), malformed JSON |
| `socket` | `--socket <copy>/api.sock` | Every request through the task API socket: static files, `/info`, `/options`, `/task/new`, task info and output, `all.zip` download, chunked upload, cancel, restart, remove. Each step must also answer as the step of the same name in `golden/default.json`. On Windows the harness checks instead that the start fails with an error saying the option is not supported there, and sends no request. |
| `socket-token` | `--token compat-secret --socket <copy>/api.sock` | A request without the token through the socket is refused as in `token`. On Windows, the same refusal check as `socket`. |
| `zip-input` | none | `seed.zip` upload, `zipurl` success and 404. Needs `unzip` or `7z`. |
| `zip-input-no-tools` | none | `seed.zip` upload and `zipurl` success when the server cannot find `unzip` or `7z`: both tasks fail with a clear error and the server keeps answering. Runs on every machine. |
| `token` | `--token compat-secret` | Every token check with and without the token |
| `fail` | `--test_fail_tasks` | A failed task, its output, download of a missing asset, restart |
| `limits` | `--max_images 1` | `maxImages` in `/info`, limit errors on direct and chunked upload |
| `skip-assets` | `--test_skip_orthophotos --test_skip_dems` | Content of `all.zip` without orthophotos and DEMs |
| `webhook` | `--webhook http://127.0.0.1:<port>/hook` | The webhook call (method, path, content type, body), and the retry after a 500 answer |
| `images-path` | `--images_root tests/images-root` | `imagesPath` in `/info`, a task from a folder through the chunked route (with a GCP file uploaded next to it) and through `/task/new`, the images folder holding only the top-level accepted files, the source folder unchanged after the tasks are removed, and the refusals: outside the root, missing folder, no supported file, with `zipurl`. The scenario creates the folder in the app copy at run time, with seeded bytes, a subfolder and a `.txt` file. |

Each golden file is `golden/<scenario>.json`: an array of `{ step, request, response }`. A response has `status`, a few headers and `body`.

The `socket` scenarios are compared twice: with their own golden file, and step by step with the step of the same name in `golden/default.json` or `golden/token.json`. The second comparison ignores the numbers of `<uuid-n>`, because the scenarios create fewer tasks. With `--update`, a scenario that fails the second comparison writes no golden file.

In the `webhook` scenario the "request" of the hook steps is what the API sent to the hook server, and the "response" is what the hook server answered. The harness waits for the hook calls (up to 10 s) and then 1.5 s more to count extra calls. The API retries a failed hook after `attempt * 5000` ms, so the first retry is immediate.

## What is normalised, and why

Only values that change between runs are changed. Everything else is compared exactly.

- Task UUIDs become `<uuid-1>`, `<uuid-2>`, ... in order of first appearance in a scenario, so relations stay checkable. The two fixed "unknown task" UUIDs (`00000000-0000-4000-8000-00000000000x`) are kept as they are, because they are the same on every run.
- `dateCreated` becomes `<date>`. Any ISO date inside a string becomes `<date>` (the default task name is `Task of <ISO date>`).
- `processingTime` becomes `<number>` when it is a number of 0 or more. `-1` is kept because it means "not processed".
- `/info`: `totalMemory`, `availableMemory` and `cpuCores` become `<number>` (when they are numbers). `version` becomes `<version>` when it looks like `1.2.3`, because it changes with every release and not with the runtime. `taskQueueCount` is kept.
- The port of the API, of the local zip server and of the hook server becomes `<port>` where it appears in strings.
- The path of the app copy becomes `<app>` where it appears in strings, and the rest of that path is written with forward slashes, so a path sent in `images-path` reads the same on every platform.
- Headers: only `status`, `content-type`, `content-disposition`, `content-length` and `access-control-allow-origin` are recorded. `content-length` is recorded as is for static files. For JSON bodies it is recorded as `<body-length>` when it equals the real body length (the length of a JSON body changes with memory sizes and times, but the header must still be present and correct). For zip downloads it is `<number>`.
- Bodies: JSON bodies are recorded parsed. HTML and static files are recorded as `sha256` and `length` (small HTML bodies also get a `text` field so they can be read). `/swagger.json` is recorded as `sha256` and `length`. Zip downloads are recorded as the sorted list of entry names with the uncompressed size of each file (`"name 123"`; directories end with `/` and have no size). Compressed size and bytes are not recorded because 7z and the JavaScript fallback compress differently.

Nothing else is normalised. Task output lines come from fixed sample files and did not vary between runs.

## Tools and skipped checks

From source, the API unpacks zips with `unzip`, else `7z`. A release archive bundles 7-Zip in `apps/7z/` (`7zzs` on Linux, `7za.exe` on Windows), and the compiled executable uses it first. When no tool is found, a task with a zip file (an upload or `zipurl`) fails with the error "Could not extract .zip file, neither unzip nor 7z is installed", and the server keeps running. So:

- The `zip-input-no-tools` scenario starts the server with a `PATH` that has neither program: one empty folder on Linux and macOS, only the Windows system folders on Windows. An empty string does not work, because Bun then searches a default path that includes `/usr/bin`. The harness looks up the server command on the real `PATH` first. The scenario checks that both tasks end with status 30 and that `/info` still answers. It is skipped, with a printed reason, when the app folder holds the bundled 7-Zip, because that app always has a tool. To check it on a release archive, run the harness on a copy without `apps/`.
- The `zip-input` scenario is skipped, with a printed reason, when both `unzip` and `7z` are missing on the harness's own `PATH` and the app bundles no 7-Zip. Its golden file holds the messages of the tools themselves, for example "unzip exited with code 9" for the 404 case, so it cannot pass without them.
- The golden file of `zip-input` holds the `unzip` message of the 404 case, "Could not extract .zip file, unzip exited with code 9". 7-Zip reports the same failure as "Could not extract .zip file, 7z exited with code 2". The harness treats these two texts as equal in that one step, so a compiled executable that runs its bundled 7-Zip passes against the golden file. No other text and no other step is treated this way.
- When `7z` is missing the API builds `all.zip` with the JavaScript fallback, which does not list top-level directory entries. The steps that return a zip listing are then not compared, and the summary line says so.
- The golden files were recorded from source with both tools, so `unzip` ran.

## Runtime differences it caught

Clients see the text of invalid-JSON errors (steps "task new error: options is not JSON" and "cancel malformed json"). That text comes from the JavaScript engine, so Bun words it differently from Node.js 14. The maintainer accepted Bun's wording for the move to Bun: these two steps were re-recorded with Bun, and the 2.6.1 changelog says so. The response shape and status code did not change.

The `swagger.json` step holds the SHA-256 of `docs/swagger.json` as served. When the version in that file was corrected from 2.5.0 to 2.6.1 (#37), the hash in `golden/default.json` was set to the hash of the new file. The length is the same. The served file does not depend on the runtime, so this is what Node.js 14 would return too. When `imagesPath` was documented (#47), the hash and the length were set to those of the new file in the same way.

Every other step is still the Node.js 14 recording.
