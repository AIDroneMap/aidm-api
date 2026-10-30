# Dependency cleanup

## Problem

Issue #11 tracks dependencies retained during the move to Bun. Some use old
APIs, and some duplicate functions provided by the runtime. Replace or upgrade
them without changing the task API, configuration or output layout.

## Approach

Make one dependency change per issue, branch and pull request. Each branch
starts from `master`. Pin upgraded dependencies to exact versions and update
only their lockfile entries and required transitive dependencies. Leave the
Bun version and unrelated dependencies alone.

| Dependency | Change | Contract to preserve |
| --- | --- | --- |
| `uuid` | Use `crypto.randomUUID()` | Generated task IDs stay UUIDv4; supplied IDs keep their validation. |
| `rimraf` | Use recursive `fs.rm()` | Cleanup remains asynchronous and missing paths are harmless. |
| `mv` | Use filesystem operations with a cross-device fallback | Upload directories, seed files and GCP files keep their destinations; failed moves do not silently lose source data. |
| `busboy` | Upgrade and adapt multipart parsing | Fields, filenames, file completion, timeouts and cancellation keep their meanings. |
| `systeminformation` | Upgrade and retain the CPU and memory queries | `/info` fields and S3 memory-based upload limits keep their meanings. |
| `archiver` | Upgrade the ZIP fallback | Task completion follows the archive file closing; archive contents stay unchanged. |
| `node-schedule` | Upgrade the scheduler | Task cleanup and stale-upload cleanup retain their schedules and shutdown behavior. |
| `request` | Replace with runtime HTTP support under #10 | ZIP downloads retain HEAD, redirects and error text; webhooks retain JSON payloads and retries. |

The removed `node-unzip-2` dependency is already covered by #19. Keep #11 open
until every remaining dependency change has merged. Link each child issue and
pull request from the tracker. Do not change the compatibility golden files
to accommodate a dependency change.

For #10, preserve the existing connection-refused and invalid-URL messages
recorded by the harness. Treat HTTP errors, redirects, stream failures and
webhook retries as compatibility cases, not opportunities to change the API.

## Validation

Every implementation adds focused regression tests for its contract. Confirm
the tests detect the old dependency or the behavior being replaced. Run
`bun test tests/unit` and
`bun tests/compat/run.js --app . -- bun index.js` with Bun from `.bun-version`.
The compatibility golden files must remain unchanged.

Every dependency pull request declares `Test depth: full` because it changes
`package.json` and `bun.lock`. Request a maintainer-run release dry run for
each head and link the run in its pull request. It checks compiled executables,
images and the GPU path. A disposable scratch machine may diagnose packaging
or runtime problems that source tests cannot cover. Its results do not replace
CI evidence or establish performance claims.

Run the independent review loop for each pull request. Resolve defects before
handing over. Only a maintainer merges. These changes make no performance claim
and do not request a benchmark unless their scope changes to target performance.

## Maintainer-approved integration addendum

On October 30, 2026, the maintainer approved one integration pull request as
the sole merge candidate. The authorization is recorded in
https://github.com/AIDroneMap/aidm-api/issues/11#issuecomment-6515315215.
This addendum replaces the separate merge and per-head full-run requirements
above. The original approach remains as the record of the component work.

Merge the exact heads of #58, #59, #60, #61, #62, #63, #64 and #65 locally
into the integration branch. Preserve their ancestry, production changes and
regression tests. Keep the component pull requests as review records. They
must not merge separately. The integration pull request closes #11, #10 and
#48 through #54 when a maintainer merges it.

Run the combined source unit tests and compatibility harness with unchanged
golden files. Check that unrelated retained dependency resolutions and the
Bun pin stay unchanged. The merge gate is one full release dry run on the
exact integration head, plus independent integration review. A later head
needs a new exact-head run. Link the run in the integration pull request.
Only a maintainer merges it after both gates pass.
