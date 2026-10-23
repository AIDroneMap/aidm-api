#!/usr/bin/env bash
# Compile the API into one executable with Bun.
#
# Usage: scripts/build.sh [--target <bun target>] [--bun-binary <path>] <outfile>
#
# Run "bun install --frozen-lockfile --production" first.
#
# The two autoload flags stop the executable from reading .env and bunfig.toml
# in the working directory. Node.js 14 never did, and a stray .env could
# silently change the configuration.
#
# --bun-binary is for cross-compiling. Without it, Bun downloads the target
# runtime from npm, and we have no checksum for that download. With it, Bun
# uses a runtime we downloaded and verified ourselves.
set -euo pipefail

usage() {
    echo "Usage: scripts/build.sh [--target <bun target>] [--bun-binary <path>] <outfile>" >&2
    exit 2
}

target=""
bun_binary=""
outfile=""

while [ $# -gt 0 ]; do
    case "$1" in
        --target)
            [ $# -ge 2 ] || usage
            target="$2"
            shift 2
            ;;
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
            [ -z "$outfile" ] || usage
            outfile="$1"
            shift
            ;;
    esac
done

[ -n "$outfile" ] || usage

# Make the output path absolute before changing directory.
case "$outfile" in
    /*) ;;
    *) outfile="$PWD/$outfile" ;;
esac
if [ -n "$bun_binary" ]; then
    case "$bun_binary" in
        /*) ;;
        *) bun_binary="$PWD/$bun_binary" ;;
    esac
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v bun >/dev/null 2>&1; then
    echo "Error: bun is not installed or not on the PATH." >&2
    exit 1
fi

wanted="$(tr -d '[:space:]' < .bun-version)"
found="$(bun --version)"
if [ "$found" != "$wanted" ]; then
    echo "Error: this build needs Bun $wanted (from .bun-version), but bun --version reports $found." >&2
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "Error: node_modules is missing. Run 'bun install --frozen-lockfile --production' first." >&2
    exit 1
fi

args=(build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig)
if [ -n "$target" ]; then
    args+=(--target "$target")
fi
if [ -n "$bun_binary" ]; then
    args+=(--compile-executable-path "$bun_binary")
fi
args+=(index.js --outfile "$outfile")

exec bun "${args[@]}"
