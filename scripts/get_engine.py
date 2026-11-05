#!/usr/bin/env python3
"""Download one pinned Windows engine archive without unpacking it.

Usage: python3 scripts/get_engine.py <variant> <outdir> [--sums <path>]
ENGINE_BASE_URL replaces the release address for local-file unit tests.
"""

import argparse
import hashlib
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.request import urlopen


SUMS = Path(__file__).with_name("engine-sha256sums.txt")
VARIANTS = ("windows-x64", "windows-x64-cuda")


def load_pins(file=SUMS):
    """Read the version and archive rows, rejecting ambiguous pins."""
    rows = [line.split() for line in Path(file).read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")]
    if not rows or len(rows[0]) != 2 or rows[0][0] != "version" or not re.fullmatch(
            r"\d+\.\d+\.\d+", rows[0][1]):
        raise ValueError("Engine sums must start with 'version <major.minor.patch>'.")
    archives = {}
    filenames = set()
    for row in rows[1:]:
        if len(row) not in (3, 4):
            raise ValueError("Invalid engine archive row in sums file.")
        digest, filename, variant = row[:3]
        if (not re.fullmatch(r"[0-9a-f]{64}", digest)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz", filename)
                or variant not in VARIANTS or variant in archives or filename in filenames):
            raise ValueError("Invalid or duplicate engine archive pin.")
        archive = {"name": filename, "sha256": digest}
        if variant == "windows-x64-cuda":
            if len(row) != 4 or not re.fullmatch(r"\d+\.\d+", row[3]):
                raise ValueError("CUDA engine pin needs minimumDriverVersion as major.minor.")
            archive["minimumDriverVersion"] = row[3]
        elif len(row) != 3:
            raise ValueError("CPU engine pin must not have minimumDriverVersion.")
        archives[variant] = archive
        filenames.add(filename)
    if archives and set(archives) != set(VARIANTS):
        raise ValueError("Engine sums must pin both Windows variants or neither.")
    return rows[0][1], archives


def download(variant, outdir, sums=SUMS):
    version, archives = load_pins(sums)
    if variant not in archives:
        raise ValueError(f"Engine {version} has no native archive for {variant}.")
    pin = archives[variant]
    base = os.environ.get("ENGINE_BASE_URL", f"https://github.com/AIDroneMap/aidm/releases/download/v{version}")
    outdir = Path(outdir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    # Keep an incomplete or unchecked download out of the destination path.
    with tempfile.TemporaryDirectory(dir=outdir) as work:
        temporary = Path(work) / pin["name"]
        digest = hashlib.sha256()
        with urlopen(f"{base.rstrip('/')}/{pin['name']}") as source, temporary.open("wb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
        actual = digest.hexdigest()
        if actual != pin["sha256"]:
            raise ValueError(f"SHA-256 mismatch for {pin['name']}: expected {pin['sha256']}, actual {actual}.")
        destination = outdir / pin["name"]
        os.replace(temporary, destination)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variant", choices=VARIANTS)
    parser.add_argument("outdir", type=Path)
    parser.add_argument("--sums", type=Path, default=SUMS)
    args = parser.parse_args()
    try:
        print(download(args.variant, args.outdir, args.sums))
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
