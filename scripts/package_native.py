#!/usr/bin/env python3
"""Assemble a Windows native package on Linux without building or downloading.

Usage: python3 scripts/package_native.py <variant> <api.zip> <engine.tar.gz> <outdir>
Optional --sums selects engine pins. SOURCE_DATE_EPOCH sets the archive time,
otherwise the last commit time is used, as in scripts/package.sh.
The adjacent <package-name>.json holds name, size and sha256 for the manifest.
--max-bytes may lower the 2 GiB release limit for fixture tests.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile

from get_engine import SUMS, VARIANTS, load_pins


ROOT = Path(__file__).resolve().parent.parent
MAX_ASSET_BYTES = 2 * 1024 ** 3


def member_path(name):
    name = name.rstrip("/")
    if (not name or "\\" in name or ":" in name
            or any(ord(char) < 32 for char in name)
            or any(part in ("", ".", "..") for part in name.split("/"))):
        raise ValueError(f"Unsafe archive path: {name!r}.")
    return PurePosixPath(name)


def extract(archive, destination, kind):
    """Accept one top folder, directories and regular files only."""
    seen = set()
    tops = set()
    with (zipfile.ZipFile(archive) if kind == "zip" else tarfile.open(archive, "r:gz")) as source:
        entries = source.infolist() if kind == "zip" else source.getmembers()
        checked = []
        for entry in entries:
            name = entry.filename if kind == "zip" else entry.name
            relative = member_path(name)
            if relative in seen:
                raise ValueError(f"Duplicate archive path: {name!r}.")
            seen.add(relative)
            tops.add(relative.parts[0])
            if kind == "zip":
                mode = entry.external_attr >> 16
                directory = entry.is_dir()
                file_type = stat.S_IFMT(mode)
                regular = file_type in (0, stat.S_IFREG) and not directory
                directory = directory and file_type in (0, stat.S_IFDIR)
            else:
                mode = entry.mode
                directory = entry.isdir()
                regular = entry.isfile()
            if not (directory or regular):
                raise ValueError(f"Archive links and special files are refused: {name!r}.")
            if len(relative.parts) == 1 and not directory:
                raise ValueError("Archive must hold exactly one top folder.")
            checked.append((entry, relative, directory, mode))
        if len(tops) != 1:
            raise ValueError("Archive must hold exactly one top folder.")
        # Validate every entry before any extraction. No archive entry can create a link.
        for entry, relative, directory, mode in checked:
            target = destination.joinpath(*relative.parts)
            if directory:
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with (source.open(entry) if kind == "zip" else source.extractfile(entry)) as data, target.open("wb") as output:
                    shutil.copyfileobj(data, output)
                target.chmod(0o755 if mode & 0o111 else 0o644)
    # mkdir respects umask; normalize every directory, including implicit parents.
    for directory in destination.rglob("*"):
        if directory.is_dir():
            directory.chmod(0o755)
    return destination / tops.pop()


def digest(file):
    result = hashlib.sha256()
    with Path(file).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def assemble(variant, api_zip, engine_archive, outdir, sums=SUMS, max_bytes=MAX_ASSET_BYTES):
    if not 0 < max_bytes <= MAX_ASSET_BYTES:
        raise ValueError(f"Size limit must be between 1 and {MAX_ASSET_BYTES} bytes.")
    version, archives = load_pins(sums)
    if variant not in archives:
        raise ValueError(f"Engine {version} has no native archive for {variant}.")
    if digest(engine_archive) != archives[variant]["sha256"]:
        raise ValueError(f"SHA-256 mismatch for {variant} engine archive.")
    api_version = json.loads((ROOT / "package.json").read_text())["version"]
    name = f"aidm-native-{api_version}-{variant}"
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if epoch is None:
        epoch = subprocess.check_output(["git", "log", "-1", "--format=%ct"], cwd=ROOT, text=True).strip()
    epoch = int(epoch)
    outdir = Path(outdir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=outdir) as temporary:
        work = Path(temporary)
        api_root = extract(api_zip, work / "api", "zip")
        if api_root.name != f"aidm-api-{api_version}-windows-x64" or not (api_root / "aidm-api.exe").is_file():
            raise ValueError("API zip must hold this version's Windows release folder and aidm-api.exe.")
        if (api_root / "engine").exists():
            raise ValueError("API zip must not already contain engine/.")
        engine_root = extract(engine_archive, work / "unpacked-engine", "tar") / "engine"
        for required in ("VERSION", "run.bat", "win32env.bat"):
            if not (engine_root / required).is_file():
                raise ValueError(f"Engine archive lacks engine/{required}.")
        found = (engine_root / "VERSION").read_text().strip()
        if found != version:
            raise ValueError(f"Engine VERSION says {found!r}, pinned version is {version}.")
        stage = work / name
        api_root.rename(stage)
        engine_root.rename(stage / "engine")
        archive = work / f"{name}.tar.gz"
        env = {key: value for key, value in os.environ.items()
               if key not in ("TAR_OPTIONS", "GZIP", "POSIXLY_CORRECT")}
        with archive.open("wb") as output, tempfile.TemporaryFile() as errors:
            with subprocess.Popen([
                "tar", "--sort=name", "--owner=0", "--group=0", "--numeric-owner",
                f"--mtime=@{epoch}", "-cf", "-", "-C", str(work), name
            ], stdout=subprocess.PIPE, stderr=errors, env=env) as tar:
                zipped = subprocess.run(["gzip", "-n"], stdin=tar.stdout, stdout=output, env=env)
                tar.stdout.close()
                code = tar.wait()
            if code or zipped.returncode:
                errors.seek(0)
                raise ValueError(f"Cannot write native archive: {errors.read().decode(errors='replace')}")
        size = archive.stat().st_size
        if size > max_bytes:
            raise ValueError(f"Native package is {size} bytes, exceeding the release asset limit of {max_bytes} bytes.")
        description = {"name": archive.name, "size": size, "sha256": digest(archive)}
        details = work / f"{name}.json"
        details.write_text(json.dumps(description, indent=2) + "\n")
        os.replace(archive, outdir / archive.name)
        os.replace(details, outdir / details.name)
    return outdir / f"{name}.tar.gz"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variant", choices=VARIANTS)
    parser.add_argument("api_zip", type=Path)
    parser.add_argument("engine_archive", type=Path)
    parser.add_argument("outdir", type=Path)
    parser.add_argument("--sums", type=Path, default=SUMS)
    parser.add_argument("--max-bytes", type=int, default=MAX_ASSET_BYTES)
    args = parser.parse_args()
    try:
        print(assemble(args.variant, args.api_zip, args.engine_archive, args.outdir, args.sums, args.max_bytes))
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
