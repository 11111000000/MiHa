# ADR 0017: The tool timeout, and the host's digest

- **Status:** Accepted
- **Date:** 2026-11-24
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0009](./0009-policy-defaults.md) (the policies) · [ADR 0010](./0010-context-policy.md) D56 (the host's better summary) · [ADR 0011](./0011-receiving-side.md) D62 (the peer waits for our own work)
- **The design:** [docs/architecture.md](../architecture.md) §2.4 and §2.5

## Context

Two edges of the harness had no law, and both could hold a run open forever.

A tool that never settles keeps its batch open, and the receiving side — which waits
for its own calls before it tells the peer that the task is over (ADR 0011 D62) — then
waits forever with it. The peer has no way to see the wait.

The context's digest is mechanical (ADR 0010 D55): one line per collapsed message, the
first words of it. It says what was lost and it is lossy, and ADR 0010 D56 promised
that a host able to ask its own model would replace it. Nothing did.

## Decision

### D99. A tool call has 120 seconds, and the host may say otherwise

`toolTimeout?: number` joins the harness config — milliseconds, default `120_000`.
`Infinity` disables the deadline. A timeout that is not a number, or is not positive,
is nonsense and gets the default.

When the deadline passes, the call is answered with an ordinary **error result** whose
text says the tool did not finish in time (law M3, and law M1: exactly one answer per
call). The tool is told through a signal of its own — the run's signal and the
deadline's — so a well-behaved tool stops instead of leaking. The tool's late answer is
ignored: the call was answered once.

**Derivation.** A policy we chose, and the smallest one that can be recommended: our
own budgets make an honest tool's work small (a result of 8 KiB, no heavy compute in a
browser), and two minutes is beyond a human's patience for a file read while still
leaving room for a legitimately slow one. A host that knows its tool is slow says so.

### D100. A host that can summarize better replaces the digest, and the journal keeps both

`HarnessHost.summarize?: (collapsed: readonly JournalEntry[], mechanical: string) =>
string | Promise<string>` — the host asks **its own** model, because the host owns the
provider. When the core collapses a range, the driver asks the host for a summary of
what it collapsed and applies a **`change`** entry, so the model reads the host's
summary where the mechanical digest was.

The journal keeps both: the compaction entry and the change that replaced its digest.
The mechanical digest stays the fallback — a host without a summarizer, one that
throws, and one that says nothing all leave the digest exactly as it was.

For the change to find the digest, the fold gives the summary item the sequence of the
*first* collapsed entry (so the items stay in the log's order) **and** the compaction
entry's own sequence (so a change can name it).

## Consequences

**Positive**

- No tool can hold a run open forever, and the peer is never left waiting on work that
  will not end.
- The model's view of a collapsed range can be as good as the host's model can make
  it, without the core knowing anything about models.

**Negative**

- A tool that legitimately needs more than two minutes must be told (the host sets
  the timeout), and a host that sets a large one has lost the bound for every tool.
- The driver keeps the recent entries so that a summarizer has something to work with —
  a bounded window, and the collapsed range it holds may be partial.
- The change the host causes is a second write to the journal: the log shows both the
  mechanical digest and the host's answer.
