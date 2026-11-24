#!/bin/sh
# The build: the page's script and the worker's script.
#
# bun is the toolchain and the only one: the example adds no dependency, and a
# bundler that had to be installed would be a dependency. Two bundles come out —
# the page's and the worker's — and the page's HTML is copied beside them.
#
#   build.sh [output directory]        (default: examples/browser/dist)
#
# The sizes are printed at the end, gzipped and counted together, and the build
# fails when they are over the ceiling.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${1:-"$here/dist"}

mkdir -p "$out"

bun build --target=browser --format=esm --minify --outfile "$out/app.js" "$here/page.entry.ts"
bun build --target=browser --format=esm --minify --outfile "$out/worker.js" "$here/worker.entry.ts"
cp "$here/index.html" "$out/index.html"

bun "$here/measure.mjs" "$out"
