# ADR 0008: The final architecture

- **Status:** Accepted
- **Date:** 2026-11-20
- **Owner:** petr p.b.kosov@yandex.ru
- **Supersedes:** the shape proposed in [ADR 0005](./0005-core-harness.md) and [ADR 0006](./0006-alternatives.md) where they conflict, as listed below
- **The design:** [docs/architecture.md](../architecture.md) — the whole architecture, how everything works

## Context

Two research cycles, five discriminator passes and a working core of ~1 900 lines
produced enough evidence to take the design apart once more and ask of every piece
whether it earns its bytes. The owner asked for the result: the final architecture,
written down as a decision.

The goal, as the owner stated it, is not a property of the model but of the harness:

> **effective · reliable · small · frugal**

Effective: the loop completes tasks at an acceptable cost in turns, tokens and time.
Reliable: the transcript stays true through every failure. Small: it fits in an
application, not the other way round. Frugal: its resident memory does not grow with
the length of the run.

## Decision

The architecture recorded in [docs/architecture.md](../architecture.md) is the design.
This ADR records the six changes the critical pass made, because they are the decisions;
the document is their consequence.

### D44. One permission seam, and it is asynchronous

The core's synchronous `beforeToolCall` hook is removed. The host supplies
`approve(call) → Promise<allow | deny | rewritten args>`, and the driver awaits it
before each tool runs. A denial becomes a `block` entry in the journal and an ordinary
error tool result, which the model reads and recovers from.

**Why.** A synchronous hook cannot ask a human, and asking a human is the core
interaction of the applications this harness is for — Genium's whole preview loop is
ask-the-user. Two permission seams was also one too many: policy belongs to the host,
and the single seam is where it is delivered. A rewritten argument travels the same path
as a validated one, so a tool always receives arguments the core has checked.

### D45. One vocabulary: the journal entry is the durable event

`AgentEvent` as a second vocabulary is retired. The journal's entries are the durable
events; everything reads them — the model's context, the trace, the session, the peer.
Live streaming deltas remain, and are ephemeral: they exist to render, and the assembled
message is the entry. Nothing recomputable from the log is stored twice.

**Why.** Two vocabularies that agree by convention drift apart under change. One log
removes the translation layer between the run, the trace and the exchange — and lets the
peer receive the same events the transcript holds.

### D46. There is no separate trace format

The trace is the journal. The cassette records only what the journal cannot: the
provider's responses, keyed by request hash. Replay is a fold of the journal with the
cassette in place of the provider.

**Why.** One artefact to store, ship and replay. A trace that is not the run's own log
is a copy that can disagree with it.

### D47. The tool receives the call's identity and the validated arguments

Not the raw argument text. The raw text is the journal's record of what the model sent;
the validated arguments are what the core checked. A tool that can re-read the raw text
can act on something the core never checked.

**Why.** This generalises the fix to the defect a discriminator found in the peer path:
a permission hook's rewrite was silently discarded. The same class of defect is removed
by construction, not by care.

### D48. The phase is derived, never stored

`phase = f(journal tail, ephemeral state)`. The core keeps no phase field in step.

**Why.** Resume is then a fold and a continue, fork is a prefix, and replay is a
re-fold — properties of the log, not features to build and keep correct.

### D49. The peer keeps a task boundary, and the journal crosses it

The exchange carries tasks and journal events, and never tools (ADR 0007). With one
vocabulary (D45), the receiving side is `delegate()` read from the other end plus
`runAgent`: accept or refuse, run one's own agent with one's own tools, send one's
events — the same entries — and end with a result.

**Why.** The symmetry the concept needs is symmetry of *tasks*, and the journal is what
makes a delegated task a fact in a log rather than a fact in a frame.

### Kept after examination

- The `report` progress callback: one parameter, part of the event vocabulary, used by
  long tools.
- The `accept` frame: three lines; it distinguishes *slow* from *refused* before any
  event arrives.

## The laws this architecture is accountable to

M1–M4 (the pairing and its survival), R1 (resident memory independent of run length),
T1 (exclusivity), T4 (assistant order), the replay law (*fold(replay(log)) ≡ fold(log)*),
S1–S7 (the stream), C1–C3 (the dialect). Each names the protocol fact it derives from,
and each carries its witness where it depends on the driver.

## The budgets

Bundle 30 000 B gzip; the result, the turns, the context and the resident window are
policies the host sets and the core enforces.

## Consequences

**Positive**

- The human-in-the-loop gap closes: an application can ask its user before a tool runs,
  and the model reads the denial as an ordinary result.
- One log serves the context, the trace, the session and the peer, and the replay law
  becomes statable and testable as a pure function.
- The memory law (R1) is achievable by construction: the windowed journal, the
  incremental fold and the bounded result are the same mechanisms that bound the token
  cost.
- The receiving side of the exchange becomes small: the same code, read from the other
  end.

**Negative**

- Removing the synchronous hook is a breaking change to the tool contract and to every
  claim whose verifier exercises it; they will be re-declared as the change lands.
- An async `approve` adds a round trip per tool call. For tools that need no approval
  the host returns `allow` immediately, but the promise boundary itself is a cost the
  synchronous hook did not have.
- The journal grows without bound in storage even though the core's resident memory does
  not; the host owns that growth and its pruning.

## Out of scope for this ADR

The implementation order, which is recorded in the architecture document §8: the journal
as durable events first, then the projection, then the async seam, then the budgets on
the driver, then the receiving side, then the cassette.

## Open questions for the owner

1. **The window's default.** How many entries the core keeps resident before the host's
   persistence is assumed — a policy awaiting measurement against real tasks.
2. **The cassette's retention.** Provider responses are keyed by request hash; how long
   they are kept, and whether they ever leave the device, is a product decision.
3. **The `block` entry's visibility.** A denial is recorded for the model and for the
   audit; whether the interface renders it as a first-class event or folds it into the
   tool result is a UI-layer decision.
