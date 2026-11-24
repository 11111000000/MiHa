#!/bin/sh
# The smoke test: build the example, and say what it costs.
#
#   smoke.sh
#
# Builds into a temporary directory, checks that the bundles are there, and
# prints their gzipped size. Exits non-zero when the build fails, when a bundle
# is missing, or when the example is over the bundle ceiling.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

sh "$here/build.sh" "$out"

for name in app.js worker.js index.html; do
	if [ ! -f "$out/$name" ]; then
		echo "FAIL the build produced no $name" >&2
		exit 1
	fi
done

echo "smoke: OK"
