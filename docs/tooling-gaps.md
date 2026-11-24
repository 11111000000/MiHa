# Two gaps in `mathc`, for the tool's owner

Found while running the method on MiHa. Both cost real time, and both are about
the specification file rather than the code.

## 1. There is no verb to amend a claim

`mathc add` refuses a duplicate id, and there is no `mathc amend`. So changing a
claim's text, its falsifier or its control means editing `spec.json` by hand — and
`spec.json` is the file the tool writes and the tool reads.

What that cost on MiHa:

- Twice in one session, a hand-edited claim was silently broken: the first time the
  `id` was left `null` and the claim was lost; the second time both new claims ended
  up with the same id, and only the map's output revealed it.
- The `falsifier` field is **not** required by `mathc add` (the claim's text is), and
  `mathc add` does not take it at all: a claim added by the tool has no falsifier,
  which is the field AGENTS.md asks every claim to carry.
- The `control` is required, and its text is a shell command the tool runs. A control
  that names a line the subject no longer has is reported as *inconclusive* — which
  is correct and useful — but the author has to notice it and re-aim the control.

**What would help.** An `mathc amend ID [--text …] [--falsifier …] [--control …]
[--scope …]` that keeps the id, the source digest and the review history, and refuses
to change a claim whose evidence is current without a reason — the same discipline
`review-source` already applies to a source.

## 2. The evidence copy has no `node_modules`, so the type check cannot be a claim

The method's evidence runs in an isolated copy of the tree. That copy has no
dependencies, so `tsc --noEmit` cannot run there — which is why the type check is a
*gate* and not a *claim* (`docs/method.md` says so plainly).

The cost is visible: a discriminator twice broke the code in ways that only the
compiler saw (a union member's field widened; a required field dropped from an event
type). Both mutations passed every test in the repository **and** every claim's
verifier; only `tsc` caught them. The claims were not wrong, but they were not
decided by their own verifiers either.

**What would help.** Either an evidence copy that can install the toolchain
(a lockfile and a `--deps` flag on the run), or a second, cheap check that runs
without the compiler: a test file of `@ts-expect-error` assertions that pins the
narrowing the laws rest on, so a change that widens a union is caught by
`bun test` as well as by `tsc`.

## A third, smaller thing

`mathc run` prints "the claim X is inconclusive" without saying *why* the control
did not bite. The reason is knowable — the sed matched nothing — and saying so would
have saved a round trip each time (it happened five times on MiHa).

— recorded from the fieldwork, 2026-11-24
