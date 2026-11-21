# How this project is developed

The method is **math-coding**. It is not a document that sits next to the work; it is
the work. Every slice of MiHa is a claim with a falsifier, a machine that checks it and
a control that proves the check can fail.

The rules are in `AGENTS.md`. This file says how they turn into a working day.

## The loop

```
   declare            implement           prove                decide
┌────────────┐   ┌──────────────┐   ┌───────────────┐   ┌──────────────┐
│ mathc add  │──▶│ write code   │──▶│ bun run check │──▶│ mathc next   │
│ (a claim)  │   │ (the subject)│   │ (the gate)    │   │ (what's next)│
└────────────┘   └──────────────┘   └───────────────┘   └──────────────┘
       ▲                                                      │
       └──────────────────────────────────────────────────────┘
                    the claim fails → the subject is wrong
```

**Before the code.** A slice starts by declaring what must be true. The claim names:

- the **subject** — the files the claim is about, inside the repository;
- the **falsifier** — the observation that would show the claim is false;
- the **verifier** — a command that decides;
- the **control** — a command that changes the subject and makes the verifier fail.

```sh
mathc add tools-laws "The dispatch planner satisfies laws M1, M2 and M3 and policy T1" \
  "src/core/tools.ts,test/tools.test.ts" \
  "A call is planned and rejected at once or neither" fact \
  --requirement "verifier:bun test test/tools.test.ts" \
  --control "sed -i 's/if (tool.concurrency === \"exclusive\") {/if (false) {/' src/core/tools.ts" \
  --source docs/adr/0006-core-decisions.md
```

A claim whose control does not break the verifier is worse than no claim: it reports a
green that means nothing. `mathc run` proves the control, every time, in an isolated
copy — so a claim that cannot fail cannot pass.

**Try the control against the subject before you declare the claim.** A control that
names a line the subject does not have changes nothing, and the method reports the
claim as *inconclusive* rather than as proven. That is the method doing its job: two
controls in this repository were declared against code that had not been written yet,
and both had to be corrected. The rule is simply to run the control once against the
subject before the claim is declared.

**Write the test first, then declare the claim over it.** This is the order that makes
the method able to *catch* anything.

The method verifies a claim by running its verifier over a subject that must exist. If
the claim is declared before anything exists, the subject is not whole, the verifier
never runs, and the claim comes back *inconclusive* — which is not a refutation, and
which the measurer does not count as a caught defect. That is exactly what happened
here: the first three claims were declared before their test file existed, and the
measurer still reports no caught defect.

The order that works:

1. **Write the test.** It fails, because the thing it tests does not exist yet.
2. **Declare the claim** with the test file in the subject. The subject now exists, so
   the verifier runs — and fails. The claim is **refuted**, and the refutation is
   recorded.
3. **Implement** until the verifier passes.
4. **Run.** The claim holds, and the trail shows a claim that was refuted and then
   fixed.

A claim that was refuted is what the measurer counts as a caught defect, and it is the
first thing that makes its usefulness criterion computable.

**The subject must include the verifier.** A claim about `src/core/tools.ts` that does
not name `test/tools.test.ts` leaves the test outside the coverage map, and a change to
the test then invalidates nothing.

**After the code.** `bun run check` is the gate. It is exactly what CI runs and exactly
what the pre-commit hook runs:

| Step | What it protects | Command | Needs `node_modules`? |
|---|---|---|---|
| budget | the 30 KB ceiling, the layer budgets, zero dependencies, no `any` | `bun scripts/check-budget.mjs` | no |
| documents | the graph resolves, decisions are defined and referenced, every number has a source | `bun scripts/check-docs.mjs` | no |
| types | the code type-checks | `tsc --noEmit` | **yes** |
| tests | the laws hold | `bun test` | no |
| evidence | every claim has current evidence, and every control still breaks its verifier | `mathc run` | no |

The gate lives in `scripts/gate.sh`; `scripts/checks.sh` holds the bun-only part and
`scripts/types.sh` the type check. The commit hook is `.githooks/pre-commit` and CI
runs the same script, so a commit that passes locally passes there.

### One honest limitation

**The type check is not a math-coding claim.** The method verifies a claim by running
its verifier in an isolated copy of the tree, and that copy is a `git clone` — so it has
no `node_modules` and no TypeScript compiler. A control that introduced a type error
would therefore fail there for a reason that has nothing to do with its subject, and the
method counts an infrastructure failure as no refutation at all: it accepts a control as
proven only when the verifier exits with code **1**.

So the type check is enforced by the commit gate and by CI, and it is *not* claimed.
Everything else — the budget, the documents and the tests — is claimed, with controls
that the method can actually confirm.

This is the shape of the limitation, not a workaround for it: a check that the evidence
environment cannot run is not a claim, it is a step of the gate.

**Then the decision.** `mathc next` prints what the method considers the next action and
why. It reads the map, not a to-do list: a refuted claim outranks an uncovered file,
and an uncovered file outranks a green verdict.

## Decisions are claims too

An ADR is not documentation; it is a **source**. A claim that cites one is bound to its
digest, so changing the ADR makes the claim stale — deliberately, because a claim
about a changed decision is not evidence about the new decision.

```sh
# the ADR changed
mathc re-evaluate
mathc review-source run-laws --by "petr p.b.kosov@yandex.ru" \
  --reason "Owner re-read the decision and directed the change"
mathc run
```

The review is recorded under the name of the person who actually re-read it. It is not a
signature and it proves nothing about identity — it is a journal entry saying who stood
behind the change.

## Where the method bites hardest

**The budget is a claim, not a hope.** "Under 30 KB gzip" is checked by a script that
fails the build, and the claim's control adds an `any` to the source to prove the check
notices.

**The laws are claims.** Every law in ADR 0004 D22 has a test, and the laws of a whole
run have a claim with a control that breaks the pairing.

**The documents are claims.** A broken link, an undefined decision label and a number
without a source are all refusals, each with its own control.

## The measurer

The method costs time. The measurer says whether it earns it:

```sh
mathc-stand "$(pwd)" \
  --human-minutes 30 --agent-tokens 10000 \
  --person-minute-cost 1 --machine-second-cost 0.01 --token-cost 0.0001 \
  --defect-cost 100
```

It compares the cost of the full protocol against running the verifiers directly in the
same environment, and counts the defects the method caught.

Measured on MiHa, 2026-11-20:

```
project                        claims uncovered  caught  stale  protocol price-arm overhead
/home/az/Projects/MiHa              9         0       0      0       3.9       0.8      3.1

protocol seconds: 3.9, price-arm seconds: 0.8, overhead: 3.1
criterion: not computable - no defect was caught
```

Two readings, both worth keeping:

- **The overhead is 3.1 seconds of machine time.** The protocol runs every verifier
  three times — the check, the control, and the check again — and the control runs in a
  fresh clone. Against a human attention cost of minutes, that is noise.
- **The criterion is not computable yet, because no declared claim has ever been
  refuted.** Every claim so far was declared *after* the code that satisfied it, so
  nothing was ever caught by the method itself. That is exactly the practice this
  repository is changing: from the next slice on, the claim comes first, and the first
  time a claim is refuted, the criterion becomes computable. Until then, the honest
  statement is that the method's value here is unproven — not that it has no value.

## What is claimed, and what is merely gated

| | Claimed (machine-confirmed, with a control) | Gated only |
|---|---|---|
| budget | yes | |
| documents | yes | |
| tests — the laws | yes | |
| the gate's own wiring | yes | |
| the type check | | yes — it needs `node_modules`, which the evidence copy does not have |
| the trace and the cassette | | not built yet |

## What the method does not do

- It does not prove the program correct. Green means the *declared* claims hold.
- It does not replace review. A human still reads the diff.
- It does not decide. `mathc` computes; the owner decides.
- It does not carry evidence between clones. `.math/` is regenerated by a run.
