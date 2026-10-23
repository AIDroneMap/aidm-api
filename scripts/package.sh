#!/usr/bin/env bash
# Build one release archive: the executable plus the files it needs.
#
# Usage: scripts/package.sh [--bun-binary <path>] <platform> <outdir>
#
# Platforms: linux-x64, linux-arm64, windows-x64.
#
# Run on Linux, from a git checkout, after
# "bun install --frozen-lockfile --production".
#
# --bun-binary is the Bun runtime for the target platform. Get it with
# scripts/get-bun.sh. Leave it out only when the target is the machine you
# are building on.
#
# The archive is named aidm-api-<version>-<platform>.tar.gz (Linux) or
# aidm-api-<version>-<platform>.zip (Windows). File order, owners and times
# are fixed, so the same source gives the same archive. Times come from
# SOURCE_DATE_EPOCH, or from the last commit if that is not set.
set -euo pipefail

usage() {
    echo "Usage: scripts/package.sh [--bun-binary <path>] <linux-x64|linux-arm64|windows-x64> <outdir>" >&2
    exit 2
}

bun_binary=""
positional=()
while [ $# -gt 0 ]; do
    case "$1" in
        --bun-binary)
            [ $# -ge 2 ] || usage
            bun_binary="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        -*)
            echo "Unknown option: $1" >&2
            usage
            ;;
        *)
            positional+=("$1")
            shift
            ;;
    esac
done
[ ${#positional[@]} -eq 2 ] || usage
platform="${positional[0]}"
outdir="${positional[1]}"

case "$platform" in
    linux-x64)   target="bun-linux-x64";   exe="aidm-api";     kind="tar" ;;
    linux-arm64) target="bun-linux-arm64"; exe="aidm-api";     kind="tar" ;;
    windows-x64) target="bun-windows-x64"; exe="aidm-api.exe"; kind="zip" ;;
    *)
        echo "Error: unknown platform '$platform'." >&2
        usage
        ;;
esac

# Make paths absolute before changing directory.
mkdir -p "$outdir"
outdir="$(cd "$outdir" && pwd)"
if [ -n "$bun_binary" ]; then
    case "$bun_binary" in
        /*) ;;
        *) bun_binary="$PWD/$bun_binary" ;;
    esac
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Error: this script needs a git checkout. It copies only files that git tracks." >&2
    exit 1
fi

version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)"
if [ -z "$version" ]; then
    echo "Error: cannot read the version from package.json." >&2
    exit 1
fi

epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
name="aidm-api-$version-$platform"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stage="$work/$name"
mkdir -p "$stage"

# 1. The executable.
build_args=(--target "$target")
if [ -n "$bun_binary" ]; then
    build_args+=(--bun-binary "$bun_binary")
fi
scripts/build.sh "${build_args[@]}" "$stage/$exe"

# 2. The files the executable reads at run time. Copy only tracked files, so a
# stray local file never ends up in a release.
copy_tracked() {
    local path
    while IFS= read -r -d '' path; do
        case "$path" in
            tests/compat/*) continue ;;
        esac
        mkdir -p "$stage/$(dirname "$path")"
        cp "$path" "$stage/$path"
    done < <(git ls-files -z -- "$@")
}

copy_tracked config-default.json public helpers scripts/postprocess.sh \
    docs/swagger.json tests LICENSE SOURCE

# The API writes here, relative to the working directory.
mkdir "$stage/tmp" "$stage/data"

# 3. Licence notices for Bun and the npm packages inside the executable.
bun scripts/third-party-notices.js "$stage/THIRD-PARTY-NOTICES.txt"

# 4. Fixed permissions, so the archive does not depend on the umask.
find "$stage" -type d -exec chmod 755 {} +
find "$stage" -type f -exec chmod 644 {} +
chmod 755 "$stage/$exe" "$stage/scripts/postprocess.sh"
if [ -d "$stage/helpers" ]; then
    find "$stage/helpers" -type f -perm -u+x -exec chmod 755 {} +
fi

# 5. The archive.
if [ "$kind" = "tar" ]; then
    archive="$outdir/$name.tar.gz"
    tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" \
        -cf - -C "$work" "$name" | gzip -n > "$archive"
else
    archive="$outdir/$name.zip"
    rm -f "$archive"
    if command -v python3 >/dev/null 2>&1; then
        py=python3
    else
        py=python
    fi
    "$py" -I -c '
import os, sys, time, zipfile

parent, name, out, epoch = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
stamp = max(time.gmtime(epoch)[:6], (1980, 1, 1, 0, 0, 0))

entries = []
for dirpath, dirnames, filenames in os.walk(os.path.join(parent, name)):
    for d in dirnames:
        entries.append(os.path.relpath(os.path.join(dirpath, d), parent).replace(os.sep, "/") + "/")
    for f in filenames:
        entries.append(os.path.relpath(os.path.join(dirpath, f), parent).replace(os.sep, "/"))
entries.append(name + "/")
entries.sort()

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for entry in entries:
        info = zipfile.ZipInfo(entry, stamp)
        info.create_system = 3
        if entry.endswith("/"):
            info.external_attr = (0o40755 << 16) | 0x10
            zf.writestr(info, b"")
        else:
            with open(os.path.join(parent, entry), "rb") as handle:
                data = handle.read()
            executable = entry.endswith(".exe") or entry.endswith(".sh")
            info.external_attr = (0o100755 if executable else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)
' "$work" "$name" "$archive" "$epoch"
fi

echo "$archive ($(wc -c < "$archive" | tr -d '[:space:]') bytes)"
