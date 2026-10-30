#!/usr/bin/env bash
# Download the official 7-Zip build for one platform and check it.
#
# Usage: scripts/get-7zip.sh <platform> <destdir>
#
# Platforms: linux-x64, linux-arm64, windows-x64.
#
# The packages come from the 7-Zip release on GitHub. The SHA-256 of each
# must match its line in scripts/7zip-sha256sums.txt, and nothing is unpacked
# before that check passes. destdir receives the executable (the static 7zzs
# on Linux, x64/7za.exe from the Extra package on Windows), License.txt from
# the same package, and source.txt with the address of the package and of the
# 7-Zip source code. The script prints the path of the executable.
#
# The Extra package is a .7z file. The script opens it with the Linux x64
# 7zzs it downloads and checks first, so windows-x64 needs a Linux x64
# machine. Linux needs tar and xz.
#
# SEVENZIP_BASE_URL and SEVENZIP_SUMS replace the download address and the
# checksum file, so the unit tests can run without the network.
set -euo pipefail

usage() {
    echo "Usage: scripts/get-7zip.sh <linux-x64|linux-arm64|windows-x64> <destdir>" >&2
    exit 2
}

[ $# -eq 2 ] || usage
platform="$1"
destdir="$2"

version="26.05"
v="${version//./}"
linux_x64="7z$v-linux-x64.tar.xz"

case "$platform" in
    linux-x64)   package="$linux_x64";               binary="7zzs" ;;
    linux-arm64) package="7z$v-linux-arm64.tar.xz"; binary="7zzs" ;;
    windows-x64) package="7z$v-extra.7z";            binary="7za.exe" ;;
    *)
        echo "Error: unknown platform '$platform'." >&2
        usage
        ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_url="${SEVENZIP_BASE_URL:-https://github.com/ip7z/7zip/releases/download/$version}"
sums="${SEVENZIP_SUMS:-$root/scripts/7zip-sha256sums.txt}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Download one package into $work and check its SHA-256.
fetch() {
    local asset="$1" expected actual
    expected="$(tr -d '\r' < "$sums" | awk -v a="$asset" '$2 == a { print $1 }')"
    if [ -z "$expected" ]; then
        echo "Error: $sums has no line for $asset." >&2
        exit 1
    fi
    echo "Downloading $base_url/$asset" >&2
    curl -fsSL --retry 5 -o "$work/$asset" "$base_url/$asset"
    actual="$(sha256sum "$work/$asset" | awk '{ print $1 }')"
    if [ "$actual" != "$expected" ]; then
        echo "Error: SHA-256 mismatch for $asset." >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        exit 1
    fi
    echo "SHA-256 of $asset matches." >&2
}

# The Linux packages hold 7zzs and License.txt at their top level.
unpack_linux() {
    mkdir -p "$2"
    tar -xJf "$work/$1" -C "$2" 7zzs License.txt
}

if [ "$platform" = "windows-x64" ]; then
    fetch "$linux_x64"
    unpack_linux "$linux_x64" "$work/tool"
    fetch "$package"
    if ! "$work/tool/7zzs" x -y -bd -o"$work/unpacked" "$work/$package" x64/7za.exe License.txt >&2; then
        echo "Error: cannot open $package with the Linux x64 7zzs. This step needs a Linux x64 machine." >&2
        exit 1
    fi
    found="$work/unpacked/x64/7za.exe"
else
    fetch "$package"
    unpack_linux "$package" "$work/unpacked"
    found="$work/unpacked/7zzs"
fi

for f in "$found" "$work/unpacked/License.txt"; do
    if [ ! -f "$f" ]; then
        echo "Error: $(basename "$f") not found in $package." >&2
        exit 1
    fi
done

mkdir -p "$destdir"
destdir="$(cd "$destdir" && pwd)"
cp "$found" "$destdir/$binary"
chmod +x "$destdir/$binary"
cp "$work/unpacked/License.txt" "$destdir/License.txt"
printf '%s\n%s\n' "$base_url/$package" "$base_url/7z$v-src.tar.xz" > "$destdir/source.txt"
echo "$destdir/$binary"
