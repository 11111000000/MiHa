#!/usr/bin/env sh
# The type check.
#
# It needs the TypeScript compiler, so it needs `node_modules`. The method's isolated
# evidence copy is a git clone and has none, which is why this check is **not** a
# math-coding claim: a control that breaks the subject would fail here for a reason
# that has nothing to do with the subject, and the method refuses to count an
# infrastructure failure as a refutation.
#
# It is still enforced: by the commit gate and by CI.

set -e

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

echo "── types ───────────────────────────────────────────────"
bun run typecheck
