#!/usr/bin/env bash
# Download the Bun release for one platform and check it.
#
# Usage: scripts/get-bun.sh <platform> <destdir>
#
# Platforms: linux-x64, linux-aarch64, windows-x64.
#
# The version comes from .bun-version. The SHA-256 of the zip must match its
# line in scripts/bun-sha256sums.txt. The script does not unpack the zip
# before that check passes. It prints the path of the Bun binary.
set -euo pipefail

usage() {
    echo "Usage: scripts/get-bun.sh <linux-x64|linux-aarch64|windows-x64> <destdir>" >&2
    exit 2
}

[ $# -eq 2 ] || usage
platform="$1"
destdir="$2"

case "$platform" in
    linux-x64|linux-aarch64) binary="bun" ;;
    windows-x64) binary="bun.exe" ;;
    *)
        echo "Error: unknown platform '$platform'." >&2
        usage
        ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(tr -d '[:space:]' < "$root/.bun-version")"
asset="bun-$platform.zip"
url="https://github.com/oven-sh/bun/releases/download/bun-v$version/$asset"

# Find the expected hash before downloading anything.
expected="$(tr -d '\r' < "$root/scripts/bun-sha256sums.txt" | awk -v a="$asset" '$2 == a { print $1 }')"
if [ -z "$expected" ]; then
    echo "Error: scripts/bun-sha256sums.txt has no line for $asset." >&2
    exit 1
fi

mkdir -p "$destdir"
destdir="$(cd "$destdir" && pwd)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Downloading $url" >&2
curl -fsSL --retry 5 -o "$work/$asset" "$url"

actual="$(sha256sum "$work/$asset" | awk '{ print $1 }')"
if [ "$actual" != "$expected" ]; then
    echo "Error: SHA-256 mismatch for $asset." >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
fi
echo "SHA-256 of $asset matches." >&2

mkdir "$work/unpacked"
if command -v unzip >/dev/null 2>&1; then
    unzip -q "$work/$asset" -d "$work/unpacked"
elif command -v python3 >/dev/null 2>&1; then
    python3 -I -m zipfile -e "$work/$asset" "$work/unpacked"
elif command -v python >/dev/null 2>&1; then
    python -I -m zipfile -e "$work/$asset" "$work/unpacked"
else
    echo "Error: need unzip or python to extract the zip." >&2
    exit 1
fi

# The zip holds one folder, bun-<platform>/, with the binary inside.
found="$work/unpacked/bun-$platform/$binary"
if [ ! -f "$found" ]; then
    echo "Error: $binary not found in $asset." >&2
    exit 1
fi

cp "$found" "$destdir/$binary"
chmod +x "$destdir/$binary"
echo "$destdir/$binary"
