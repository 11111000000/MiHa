# ADR 0006: The alternatives, and what we take from them

- **Status:** Proposed
- **Date:** 2026-11-20
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0002](./0002-core-harness.md), [ADR 0003](./0003-core-scope.md), [ADR 0004](./0004-quality-bar.md), [ADR 0005](./0005-core-harness.md)
- **Research base:** [research 05](../research/05-alternative-architectures.md), [research 03](../research/03-pi-core-teardown.md)

## Context

The owner asked the question that decides the architecture rather than decorating it:
*which alternative architectures are on the table right now, and would any of them make
MiHa smarter, better fitted, more compact or more effective?*

Two research passes answered it — one over the formal models (including the "DeepSeek
harness" that does exist), one over the measured landscape. The findings that bear on
the decision are in [research 05](../research/05-alternative-architectures.md). Four of
them change what we do next:

1. **The "DeepSeek harness" is real** — `deepseek-ai/deepseek-harness`, MIT, TypeScript,
   built on Cordis. The mathematics is one layer down and is about *component
   composition*, not the agent loop; the loop itself is imperative and unformalised.
2. **Schemas amortise; results compound.** Our own measurement: the schema share of the
   context falls from 74 % to 19 % over twelve turns, while the context grows 3.9× and
   112 K tokens are sent. The measured cost of unbounded tool *results* is ≈3 350·N²
   cumulative tokens. **MiHa has no law bounding a tool result.**
3. **Our peer exchange withholds the delegator's decisions.** A peer calls our tools
   without seeing which affordances we chose to expose or how we phrased them. Cognition's
   principle is *"share context, and share full agent traces, not just individual
   messages"*; A2A, MCP and AG-UI all carry **declarations and attribution**, never a
   callable handle into the other side's tools. **Our `call` frame is a callable handle.**
4. **Progressive disclosure did not survive its own preregistered test**, and mutating the
   tools array mid-conversation invalidates the prompt cache. A constant registry is the
   right shape for us.

## Decision

### D34. A tool result has a byte budget, enforced by the core

The core truncates a tool result to a budget and says so in the result, so the model is
told the output was cut rather than silently handed a fragment it might trust.

The budget is a **policy** (the host sets it), but the **enforcement** is the core's, for
the same reason argument validation is: a tool that is left to police its own output is a
tool that will not.

Why this and not the alternatives: the evidence says the compounding is in the results,
not the schemas, and that three production browser agents all bound theirs. The cost of
the law is a few lines. The cost of not having it is measured and quadratic.

The truncation keeps the **beginning and the end** of the result and marks the cut in
the middle. Keeping the end matters: the tail of a tool result is often the part the
model needs (the error, the count, the last line).

### D35. The host may rewrite the request in flight

The core fixes the `ProviderRequest`; the host's only influence today is the opaque
`options` bag. That means anything the browser needs to do *to the request* — elide a
stale result, switch the model for one turn, attach a deadline, force compaction on
overflow, retry one transient provider error — has to happen *around* the core or not at
all.

The seam is one optional function on the host, called by the driver between "the core
emitted a `provider_request`" and "the host performs it". It is the cheapest thing on
the alternatives list and it unblocks the most.

### D36. The offer carries the delegator's decisions

The peer exchange is ours and it is the core of the concept, so the weakness the evidence
points at is ours to fix. The `offer` frame carries the tool names **with their
descriptions** — the declarations the protocols would carry — so the peer acts on what
the delegator actually exposes, not on a list of bare names.

We go further than a declaration, and the reason is measured: a peer that has to guess
what a tool does will guess wrong more often as the tool set grows, and richer
descriptions that mislead are *worse* than none. The offer therefore carries the
delegator's **tool descriptions verbatim**, and nothing else about the delegator's
reasoning. That is the line the protocols draw: a declaration, never a handle into the
other side's state.

What we deliberately do **not** do is ship the delegator's transcript to the peer. It is
larger, it is the delegator's business, and the description is what the peer needs to
call a tool correctly.

### D37. Every mutable field of the run state names its merge

We do not restructure the state into channels yet — `phase` is not a mergeable field,
and pretending otherwise would be unsound. But the **discipline** is adopted: every
mutable field declares how two values merge, and the laws that concern merged fields are
stated in terms of the merge.

Concretely: `entries` append, `calls` append, `results` upsert by `toolCallId`, `queued`
appends, `turn` and `nextId` take the maximum, `phase` is computed by the step and
therefore never merged. Law **T4** — results are recorded in assistant order — is then a
statement about the `results` merge, and its negative control becomes a unit test with
no provider in it.

### D38. The laws are stated as absolutes only where they are absolutes

A law that depends on the driver running the plan is a property of the machine **and**
its driver, and saying otherwise is how a law comes to be believed when it does not hold.
Each such law is restated with its witness: the plan's grouping is the evidence that
every call of the batch appears exactly once, in `groups` or in `rejections`.

This is a wording change with no runtime cost, and it makes the law set honest about
where its evidence comes from.

### D39. The next structural step is the durable event log with fold projections

The transcript becomes a typed event log with an envelope, and the model context becomes a
**named projection** with its own fold. Three things follow, and they are why this is the
next structural step rather than a later one:

- **Compaction stops being a special case.** It becomes a change to one fold, and the log
  keeps the evidence — which is what a trace is.
- **The replay law becomes statable**: *fold(replay(log)) ≡ fold(log)*. That is the
  check the development style needs: the same run, replayed, must produce the same
  context.
- **The peer exchange stops being a second vocabulary.** The exchange can carry the
  same events the transcript does, so "the frontend handed the backend a task" becomes a
  fact in the log rather than a fact in a frame. Fixed as policy in
  [ADR 0008](./0008-final-architecture.md) D45: the journal entry *is* the durable
  event, and `AgentEvent` as a second vocabulary is retired.

The cost is an event taxonomy, a projection registry, a sequence counter and versioning
discipline — roughly 150–250 lines and about 1 KB gzip, inside the budget.

### D40. Deferred, with the reason

| Deferred | Why |
|---|---|
| Progressive disclosure of tools | the preregistered test found the hypothesis did not survive; mutating the tools array invalidates the prompt cache; our registry is a dozen tools and constant |
| Programmatic tool calling (code mode) | the sandbox is a dependency, and a code tool over page-local DOM actions turns a declared tool list into arbitrary script in the user's page — what the permission seam exists to prevent |
| Fixed verbs instead of the loop | not a replacement but a configuration: the host should be able to decide the turn count for tasks whose shape it knows. That is a `turnLimit` the host sets, and it comes with the loop's optionality |
| A graph runtime (LangGraph-style) | our laws are checked by substitution on a pure function; a runtime would add a checkpoint store and a node model we do not need |
| Effect as a runtime | its laws buy refactoring, not agent-level invariants; the notation is worth borrowing, the runtime is not |

## Consequences

**Positive**

- The one gap the evidence names as most expensive in our own codebase — an unbounded
  tool result — is closed, in the core, in a few lines.
- The host gains the ability to shape the request, which is what every production
  browser agent does with middleware, without a middleware runtime.
- The peer exchange stops being the one place where our design contradicts every
  agent-to-agent protocol in the field.
- The law set becomes honest about where its evidence comes from.

**Negative**

- A result budget is a policy the host must set sensibly. Too small and the model
  loses what it needed; too large and the compounding returns. The default has to be
  chosen, and it is a guess until it is measured against real tasks.
- Carrying descriptions in the offer makes the frame bigger and couples the two sides'
  vocabularies: if the delegator renames a tool, the peer's view is stale until the
  next offer.
- The event-log model is the largest change MiHa will make, and it touches the
  transcript, the projection, the exchange and the trace at once.

**Neutral**

- Most of the alternatives list was rejected on **evidence**, not taste: two of them
  have measured costs that do not apply to us, and one has a measured cost that
  contradicts its own hypothesis.
- The formal models contributed **wording and discipline**, not machinery. We already
  write in the style of the Cordis witness; we now say so.

## Out of scope for this ADR

- The event taxonomy and the projection registry: the next ADR.
- The default result budget and how it is chosen.
- The transport and the reconnection policy of the exchange.

## Open questions for the owner

1. **The result budget's default.** 8 KB is what nanobrowser uses; the browser-use
   default is different again. What is right for reading a DOM subtree or a document?
2. **The offer's contents.** Descriptions only, or descriptions plus the recent
   transcript? The second is what Cognition asks for and the first is what the
   protocols ship.
3. **The event log's envelope.** A sequence number and a schema version, as DeepSeek
   does, or something smaller of our own?
