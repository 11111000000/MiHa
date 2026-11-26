#!/usr/bin/env sh
#
# Publishes the site to GitHub Pages.
#
# Builds the example, assembles a gh-pages tree (the site at /, the example at
# /example/), and pushes it as the gh-pages branch. The branch is rewritten every
# time: it is build output, not history.
#
# Usage: sh site/publish.sh [remote]

set -e
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

REMOTE="${1:-origin}"
# The remote may be a relative name ("origin") and the script changes directory:
# resolve it to a URL before anything moves.
REMOTE="$(git remote get-url "$REMOTE")"
STAGE="$(mktemp -d /tmp/miha-gh-pages.XXXXXX)"

echo "── checking the diagrams ──────────────────────────────"
python3 site/check-diagrams.py

echo "── building the example ───────────────────────────────"
sh examples/browser/build.sh

echo "── assembling the gh-pages tree ───────────────────────"
cp site/index.html "$STAGE/index.html"
mkdir -p "$STAGE/example"
cp examples/browser/dist/index.html "$STAGE/example/index.html"
cp examples/browser/dist/app.js "$STAGE/example/app.js"
cp examples/browser/dist/worker.js "$STAGE/example/worker.js"

echo "── pushing gh-pages ───────────────────────────────────"
cd "$STAGE"
git init -q
git checkout -q -b gh-pages
git add -A
git commit -qm "the site: $(date -u '+%Y-%m-%dT%H:%MZ')"
git push -qf "$REMOTE" gh-pages:gh-pages

echo "published. the pages URL follows in a minute or two."
rm -rf "$STAGE"
