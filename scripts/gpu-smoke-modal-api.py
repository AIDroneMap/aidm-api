#!/usr/bin/env python3
#
# GPU smoke test of the AIDM API GPU image on a real NVIDIA GPU, on Modal.
#
# Starts the image by digest in a Modal Sandbox with one GPU, starts the API
# in it, and goes through the API like "scripts/smoke-test.sh api" in the
# engine repository: create a task, upload the dataset, wait, download
# all.zip and check the outputs. It also checks the task output, which is the
# engine log, for "nvidia-smi detected" and for DensifyPointCloud runs with
# --cuda-device -1. It exits non-zero on any failure.
#
# smoke-test.sh starts the image with docker, which a Sandbox does not have,
# so this script makes the same HTTP calls with curl inside the Sandbox. The
# API is never reachable from outside the Sandbox.
#
# The dataset, the output list, the engine log checks and the cost estimate
# come from the engine's scripts/gpu-smoke-modal.py and scripts/smoke-test.conf.
# Download both from the engine release the image is built on, into one folder.
#
# Usage:
#   scripts/gpu-smoke-modal-api.py <engine scripts folder> ghcr.io/aidronemap/aidm-api@sha256:<digest>
#
# Environment: the same as the engine's gpu-smoke-modal.py (MODAL_TOKEN_ID,
# MODAL_TOKEN_SECRET and MODAL_ENVIRONMENT required; REGISTRY_USERNAME,
# REGISTRY_PASSWORD, SMOKE_GPU, SMOKE_CPU, SMOKE_MEMORY, SMOKE_TIMEOUT,
# SMOKE_OPTIONS and SMOKE_CACHE optional).
#
# Everything it creates on Modal is ephemeral: one app that stops when the
# script ends, one Sandbox, and a registry secret that exists for this run
# only. Needs the modal Python package; the release workflow pins its version.

import importlib.util
import json
import os
import shlex
import sys
import time

APP_NAME = "aidm-api-gpu-smoke"
API = "http://127.0.0.1:3000"
WORK = "/tmp/gpu-smoke"
POLL_SECONDS = 15


def load_engine_script(folder):
    """Load the engine's gpu-smoke-modal.py, which reads smoke-test.conf from its own folder."""
    path = os.path.join(folder, "gpu-smoke-modal.py")
    spec = importlib.util.spec_from_file_location("engine_gpu_smoke", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def options_json(options, cpu):
    """Turn "--dsm --foo 2" into the API's options list, like smoke-test.sh does."""
    opts, args = [], shlex.split(options)
    while args:
        name = args.pop(0).lstrip("-")
        value = True
        if args and not args[0].startswith("--"):
            value = args.pop(0)
        opts.append({"name": name, "value": value})
    # The Sandbox may report more cores than it has, so cap the engine like
    # the engine's GPU test does
    if not any(o["name"] == "max-concurrency" for o in opts):
        opts.append({"name": "max-concurrency", "value": max(1, int(cpu))})
    return json.dumps(opts)


def main():
    if len(sys.argv) != 3 or "@sha256:" not in sys.argv[2]:
        print("Usage: %s <engine scripts folder> <image>@sha256:<digest>" % sys.argv[0], file=sys.stderr)
        return 2
    engine = load_engine_script(sys.argv[1])
    image_ref = sys.argv[2]
    log = engine.log

    # Never fall back to the default Modal environment
    environment = engine.env_required("MODAL_ENVIRONMENT")
    engine.env_required("MODAL_TOKEN_ID")
    engine.env_required("MODAL_TOKEN_SECRET")

    config = engine.read_config()
    gpu = os.environ.get("SMOKE_GPU", "T4")
    cpu = float(os.environ.get("SMOKE_CPU", "4"))
    memory = int(os.environ.get("SMOKE_MEMORY", "16384"))
    timeout = int(os.environ.get("SMOKE_TIMEOUT", "2400"))
    options = os.environ.get("SMOKE_OPTIONS") or config["DEFAULT_OPTIONS"]
    cache = os.environ.get("SMOKE_CACHE") or os.path.expanduser("~/.cache/aidm-smoke-test")
    outputs = config["OUTPUTS"].split()

    images = engine.fetch_dataset(config, cache)

    import modal

    registry_secret = None
    if os.environ.get("REGISTRY_USERNAME") and os.environ.get("REGISTRY_PASSWORD"):
        # Exists for this run only, never stored as a named Modal secret
        registry_secret = modal.Secret.from_dict({
            "REGISTRY_USERNAME": os.environ["REGISTRY_USERNAME"],
            "REGISTRY_PASSWORD": os.environ["REGISTRY_PASSWORD"],
        })

    # Without add_python, Modal adds nothing to the image. Clearing the
    # entrypoint lets the Sandbox run our command instead of the API; it
    # changes no files.
    image = modal.Image.from_registry(
        image_ref,
        secret=registry_secret,
        setup_dockerfile_commands=["ENTRYPOINT []"],
    )

    log("Image %s" % image_ref)
    log("Modal: GPU %s, %g CPU cores, %d MiB memory, timeout %d s" % (gpu, cpu, memory, timeout))

    app = modal.App(APP_NAME)
    problems = []
    sandbox_seconds = 0.0
    task_seconds = 0.0
    smi = ""

    def curl(sb, args, echo=False):
        """Run curl in the Sandbox. Returns its output, or None after recording a problem."""
        code, out = engine.run(sb, "curl -fsS " + " ".join(shlex.quote(a) for a in args), echo=echo)
        if code != 0:
            problems.append("curl %s failed with exit code %s: %s" % (args[-1], code, out.strip()[-300:]))
            return None
        return out

    with modal.enable_output(), app.run(environment_name=environment):
        sb = modal.Sandbox.create(
            "sleep", str(timeout),
            app=app,
            image=image,
            gpu=gpu,
            cpu=cpu,
            memory=memory,
            timeout=timeout,
        )
        # Count Sandbox time from here: the image build above is not GPU time
        started = time.monotonic()
        try:
            log("Sandbox %s started" % sb.object_id)

            log("GPU and driver:")
            code, smi = engine.run(sb, "nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader")
            problems += engine.check_nvidia_smi(code, smi)
            _, header = engine.run(sb, "nvidia-smi", echo=False)
            log("CUDA version: %s" % (engine.cuda_version(header) or "not shown by nvidia-smi"))

            log("Uploading %d images to the Sandbox" % len(images))
            remote_images = []
            for path in images:
                remote = "%s/images/%s" % (WORK, os.path.basename(path))
                sb.filesystem.copy_from_local(path, remote)
                remote_images.append(remote)

            # The API runs from /var/www, as in the image. Its log stays in the
            # Sandbox and is printed if something fails.
            log("Starting the API")
            sb.exec("bash", "-c", "exec /var/www/aidm-api --port 3000 > %s/aidm-api.log 2>&1" % WORK,
                    workdir="/var/www")

            info = None
            for _ in range(120):
                code, out = engine.run(sb, "curl -fsS %s/info" % API, echo=False)
                if code == 0:
                    info = out
                    break
                time.sleep(1)
            if info is None:
                problems.append("the API did not answer at %s/info" % API)
            else:
                log("API info: %s" % info.strip())

            uuid = None
            if not problems:
                out = curl(sb, ["-X", "POST", "-F", "name=gpu-smoke-test",
                                "-F", "options=%s" % options_json(options, cpu),
                                "%s/task/new/init" % API])
                if out is not None:
                    uuid = json.loads(out)["uuid"]
                    log("Task %s created, uploading images" % uuid)

            if uuid:
                files = []
                for remote in remote_images:
                    files += ["-F", "images=@%s" % remote]
                if curl(sb, ["-X", "POST"] + files + ["%s/task/new/upload/%s" % (API, uuid)]) is not None:
                    curl(sb, ["-X", "POST", "%s/task/new/commit/%s" % (API, uuid)])

            status = None
            if uuid and not problems:
                task_started = time.monotonic()
                # Leave two minutes of Sandbox time for the download and checks
                deadline = started + timeout - 120
                while time.monotonic() < deadline:
                    out = curl(sb, ["%s/task/%s/info" % (API, uuid)])
                    if out is None:
                        break
                    info = json.loads(out)
                    status = info["status"]["code"]
                    if status in (30, 40, 50):
                        break
                    log("Status %s, progress %s%%" % (status, info.get("progress")))
                    time.sleep(POLL_SECONDS)
                task_seconds = time.monotonic() - task_started
                if status == 40:
                    log("Task finished in %d seconds" % task_seconds)
                elif status in (30, 50):
                    problems.append("the task ended with status %s: %s"
                                    % (status, info["status"].get("errorMessage", "")))
                elif status is not None:
                    problems.append("the task did not finish before the Sandbox timeout")

            # The task output is the engine log: it shows whether the GPU was used
            if uuid:
                out = curl(sb, ["%s/task/%s/output" % (API, uuid)])
                if out is not None:
                    engine_log = "\n".join(json.loads(out))
                    log("Engine log:")
                    print(engine_log, flush=True)
                    problems += engine.check_engine_log(engine_log)

            if status == 40:
                zip_path = "%s/all.zip" % WORK
                if curl(sb, ["-o", zip_path, "%s/task/%s/download/all.zip" % (API, uuid)]) is not None:
                    size = sb.filesystem.stat(zip_path).size
                    log("Downloaded all.zip (%d bytes)" % size)
                    code, _ = engine.run(sb, "python3 -I -m zipfile -e %s %s/project" % (zip_path, WORK))
                    if code != 0:
                        problems.append("all.zip could not be extracted")
                    for out in outputs:
                        try:
                            size = sb.filesystem.stat("%s/project/%s" % (WORK, out)).size
                        except Exception:
                            size = 0
                        if size > 0:
                            log("ok    %s (%d bytes)" % (out, size))
                        else:
                            log("MISSING OR EMPTY  %s" % out)
                            problems.append("%s is missing or empty in all.zip" % out)

            if problems:
                log("Last lines of the API log:")
                engine.run(sb, "tail -n 50 %s/aidm-api.log" % WORK)
        finally:
            sb.terminate()
            sandbox_seconds = time.monotonic() - started

    gpu_line = smi.strip().splitlines()[0] if smi.strip() else "unknown"
    log("GPU: %s" % gpu_line)
    log("Task time %d s, Sandbox time %d s" % (task_seconds, sandbox_seconds))
    if gpu in engine.GPU_PRICES:
        per_second = engine.GPU_PRICES[gpu] + cpu * engine.CPU_PRICE + memory / 1024 * engine.MEMORY_PRICE
        log("Estimated cost: USD %.2f (list prices x Sandbox time, image build not included)"
            % (per_second * sandbox_seconds))

    if problems:
        for p in problems:
            log("FAIL: %s" % p)
        return 1
    log("PASS: the API ran a task on the GPU and all.zip has every output")
    return 0


if __name__ == "__main__":
    sys.exit(main())
