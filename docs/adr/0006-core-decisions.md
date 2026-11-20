# ADR 0006: The four decisions of the core design pass

- **Status:** Accepted
- **Date:** 2026-11-20
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0005](./0005-core-harness.md) D24–D32
- **Research base:** [research 03](../research/03-pi-core-teardown.md) §17

## Context

ADR 0005 left four questions open, each of which changes the shape of the state
machine. The owner has taken all four.

The answers were taken from the comparison in the decision interface, where each option
carried its pros and cons against stated criteria. **The recorded set is the recommended
set — A in every case.** If any of them was meant differently, this ADR is one edit
away from being wrong, and it says so rather than hiding it.

## Decision

### D29. The transcript is the durable record; everything else is derived

The transcript is an append-only list of entries. It is the single source of truth.
Session state, the model context and the trace are **projections** of it.

| | Chosen | Rejected | Why chosen |
|---|---|---|---|
| Source of truth | **the transcript** | a separate session store; the transcript with a materialised cache | one place means divergence is impossible by construction; undo is an append, not a mutation; the trace *is* the transcript; and it travels unchanged between a page, a worker and a peer |

**Consequence.** There is no second persistence layer. The session store interface
becomes "append an entry, read a range, read by id" and nothing more. The trace module
shrinks: it is no longer a format of its own, but the transcript plus a run record.

### D30. The provider request is a plain message list; the adapter lowers it

The core hands the host a flat request — system prompt, messages, tools, and an opaque
options bag — and the adapter lowers it to the provider's wire format.

| | Chosen | Rejected | Why chosen |
|---|---|---|---|
| Request shape | **flat list** | a structured request the adapter lowers | it follows directly from the core doing no I/O; the adapter stays around ten lines; one representation of the conversation for every provider |

**Consequence, and it is a good one.** The core no longer manages the provider's prompt
cache — that is the host's business, expressed through the options bag. But the core
gives the host something better than a cache marker: **an append-only transcript is
byte-stable at the front by construction**, so the prefix a provider caches survives
every turn for free. The one thing that breaks it is a compaction, and that is exactly
where a host should expect a single cache miss.

It also means the tool-choice mode ("auto", "never", "required") is the host's to set,
and that the core's request type does not grow as provider features are added.

### D31. The core never reads a clock; the host stamps

Time reaches the core only as an input, or not at all.

| | Chosen | Rejected | Why chosen |
|---|---|---|---|
| Clock | **the host's** | the core reads one | `step` stays a pure function; every law stays checkable by substitution; timeouts and "when did this happen" are testable by supplying time, not by replacing a global |

**Consequence, and it forced a design change.** The core cannot stamp a time on the
assistant message it creates — it does not know the time. So:

- **Messages carry no timestamp.** Order is positional; the transcript is append-only, so
  position *is* the order. The core's message types lose the field entirely rather than
  making it optional, because a field that is sometimes absent is partiality (ADR 0004
  Q4).
- **The core never writes to storage either.** Appending an entry is an *intent*, like
  calling a provider or running a tool. The host performs the append and may stamp the
  time as it does.

This closes a gap that was open in ADR 0005 D24: the core now emits **three** kinds of
intent — provider request, tool plan, transcript append — and performs none of them.
The transcript the core holds is its in-memory view; the durable one is what the host
wrote.

### D32. The turn limit is a policy, and the peer has its own

A run stops at a limit, and the limit is chosen by the host — separately for a local run
and for a delegated task.

| | Chosen | Rejected | Why chosen |
|---|---|---|---|
| Turn limit | **policy, per run and per delegation** | one global limit; no limit at all | a delegated task has its own budget and its own cost; and the report must be able to say *why* a run stopped |

**Consequence.** The run's outcome grows a fourth case:

```ts
export type Outcome =
  | { readonly kind: "completed" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "limitReached"; readonly turns: number };
```

"Stopped because the limit" is not the same as "stopped because it was done", and not
the same as "failed". A run that hits its limit is a **budget** event, and it is
reported as one — in the trace, in the outcome, and over the peer link.

## Consequences

**Positive**

- The core has no clock, no storage and no provider client. Three whole categories of
  defect are gone before they can be written.
- The transcript is the only thing that must be understood, stored and transported.
- The prompt-cache prefix is stable by construction rather than by a mechanism.
- A run's outcome distinguishes four different endings, and the peer can be told which.

**Negative**

- The core's message types have no time on them, so a host that wants a time per
  message must carry it alongside — one more thing the host does.
- The append intent adds a third kind of intent to the driver, and the driver now
  performs three different sorts of work: I/O with a provider, I/O with a tool, and
  I/O with storage.
- Cache stability is guaranteed except after a compaction, and a host that cares must
  expect one miss there.

**Neutral**

- The turn limit being policy means it is not part of the core's correctness — it is a
  value the host passes in, and the core's only obligation is to honour it and say so.

## Alternatives considered

| Alternative | Why not |
|---|---|
| A separate session store as the source of truth | Two structures for one concept, with a divergence risk that has to be policed by an invariant; undo becomes a mutation |
| The transcript with a materialised projection cache | Adds a second level of storage and an invalidation rule, for an access pattern we do not yet have |
| A structured provider request | The request type would grow with the core and turn it provider-shaped; the adapter would stop being trivial |
| The core reading a clock | `step` stops being a function of its inputs; deterministic traces become impossible |
| One global turn limit | A delegated task on a server would be bounded by a browser's limit, or a browser agent by a server's — wrong in both directions |
| No turn limit at all | A stalled agent with no host keeps spending tokens; this is a real class of failure |

## Out of scope for this ADR

- The exact shape of the provider request and its options bag.
- The storage interface's details.
- The compaction mechanism.
- The run record's format.

## Open questions for the owner

1. **What "decentralised" means here.** This ADR treats it as symmetry: two MiHa
   instances, either of which may offer a task and call back. If it means something
   else — several equal agents with no coordinator, for instance — the protocol's shape
   changes, and it is cheaper to know now than after the exchange layer is written.
2. **The turn limit's default.** The decision fixes that it is policy; the number is
   still unset.
3. **Whether the trace is the transcript plus a run record, or a separate artefact.**
   The first follows from D29 and costs one module; the second keeps the transcript
   clean for the peer and costs a second format.
