#!/usr/bin/env bash
# Check that every place that pins Bun agrees with .bun-version.
#
# Usage: scripts/check-bun-pins.sh
#
# Docker and Apptainer cannot read .bun-version, so they carry the image tag
# and digest in FROM. This script fails when one of them is out of date.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail=0
problem() {
    echo "FAIL: $*" >&2
    fail=1
}

version="$(tr -d '[:space:]' < .bun-version)"
if [ -z "$version" ]; then
    echo "FAIL: .bun-version is empty." >&2
    exit 1
fi
echo "Bun version in .bun-version: $version"

digests=""
for file in Dockerfile Dockerfile.gpu apptainer.def; do
    if [ ! -f "$file" ]; then
        problem "$file is missing."
        continue
    fi
    # Matches oven/bun:<version>-<variant>@sha256:<64 hex digits>.
    pin="$(grep -oE "oven/bun:[0-9][^@[:space:]]*@sha256:[0-9a-f]{64}" "$file" | head -n 1 || true)"
    if [ -z "$pin" ]; then
        problem "$file has no oven/bun:<version>-<variant>@sha256:<digest> reference."
        continue
    fi
    tag="${pin#oven/bun:}"
    tag="${tag%%@*}"
    digest="${pin##*@sha256:}"
    case "$tag" in
        "$version"-*) ;;
        *) problem "$file uses oven/bun:$tag, which does not start with $version-." ;;
    esac
    echo "$file: oven/bun:$tag@sha256:$digest"
    digests="$digests$digest
"
done

unique="$(printf '%s' "$digests" | sort -u | grep -c . || true)"
if [ "$unique" -gt 1 ]; then
    problem "the image digests differ between Dockerfile, Dockerfile.gpu and apptainer.def."
fi

for asset in bun-linux-x64.zip bun-linux-aarch64.zip bun-windows-x64.zip; do
    if tr -d '\r' < scripts/bun-sha256sums.txt | awk -v a="$asset" '$2 == a { found = 1 } END { exit !found }'; then
        echo "scripts/bun-sha256sums.txt: has a line for $asset"
    else
        problem "scripts/bun-sha256sums.txt has no line for $asset."
    fi
done

if [ -f scripts/notices/bun-LICENSE.md ]; then
    echo "scripts/notices/bun-LICENSE.md: exists"
else
    problem "scripts/notices/bun-LICENSE.md is missing."
fi

if [ "$fail" -ne 0 ]; then
    echo "Bun pins are inconsistent. Update them together." >&2
    exit 1
fi
echo "OK: all Bun pins agree."
