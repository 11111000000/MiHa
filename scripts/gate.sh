#!/usr/bin/env sh
# The gate, run before every commit.
#
# It is the same gate CI runs. If it fails here, it will fail there, and the commit
# is not ready either way.
#
# Three parts, in this order:
#
#   1. the checks — budget, documents, tests. These run on bun alone, so the method
#      can verify them, controls and all.
#   2. the types — the TypeScript compiler. It needs node_modules, which the isolated
#      evidence copy does not have, so it is enforced here and in CI but is not a
#      math-coding claim.
#   3. the evidence — `mathc run`, which re-runs each claim's verifier, proves each
#      claim's control still breaks it, and reports the verdict.
#
# The third part is what makes the first two mean anything: a check that cannot fail
# proves nothing, and the controls are what prove it can.

set -e

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

sh scripts/checks.sh

sh scripts/types.sh

echo "── evidence ────────────────────────────────────────────"
mathc run

echo ""
echo "gate: OK"
