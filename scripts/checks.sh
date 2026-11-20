#!/usr/bin/env sh
# The checks that need nothing but bun.
#
# These are the checks the method can verify on its own: the isolated evidence copy is
# a git clone, so it has no node_modules and no TypeScript compiler. Everything here
# runs on bun alone, which is why it can be machine-confirmed, controls and all.
#
# The type check lives in scripts/types.sh, because it needs the toolchain.

set -e

# The root is found from the script itself, not from git: the method runs the
# verifiers in an isolated copy that has no .git, and a check must not depend on
# the repository metadata to know where it is.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

echo "── budget ──────────────────────────────────────────────"
bun scripts/check-budget.mjs

echo "── documents ───────────────────────────────────────────"
bun scripts/check-docs.mjs links
bun scripts/check-docs.mjs decisions
bun scripts/check-docs.mjs attribution

echo "── tests ───────────────────────────────────────────────"
bun test
