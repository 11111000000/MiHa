# ADR 0003: How much of pi to take, and what "parity" means

- **Status:** Proposed
- **Date:** 2026-11-20
- **Owner:** petr p.b.kosov@yandex.ru
- **Supersedes:** [ADR 0002](./0002-core-harness.md) — decisions D2 and D7 are replaced;
  D15–D17 are added. The rest of ADR 0002 stands.
- **Research base:** [research 03](../research/03-pi-core-teardown.md), [research 01](../research/01-reference-landscape.md), [research 02](../research/02-scenario-runtime-landscape.md)

## Context

ADR 0002 D2 proposed that the agent core be "a pinned, trimmed port of upstream
`pi-agent-core`". The owner pushed back on that, for two reasons that are worth taking
seriously rather than defending:

1. **A port may be too much.** We do not want a large harness. MiHa might be able to be
   more compact, more efficient and higher quality if written for its actual job.
2. **Full parity with pi may be unnecessary** for the frontend case, where the agent
   has characteristic tasks. Perhaps parity should be an *extension* that is available
   when someone builds a full backend harness — if that has advantages.

Research cycle 3 was commissioned to answer this with measurements rather than
opinions. The findings are in [research 03](../research/03-pi-core-teardown.md); the
five that decide it:

| Finding | Number | Source |
|---|---|---|
| "2 548 LOC" is the whole package, mostly comments | **1 773** code-only; the loop and facade are **1 437** | research 03 §1 |
| The loop's feature split | ≈ 574 irreducible · ≈ 300 frontend-specific · ≈ 726 policy/catalogue · ≈ 195 droppable | research 03 §2 |
| A correct core is much smaller than pi's | **≈ 730–990** code LOC; **≈ 570–760** if the app owns state | research 03 §6 |
| Most of upstream is not derivable from first principles | **16** behaviours, **8** of which fail silently | research 03 §8 |
| Upstream's test suite is browser-safe and encodes those behaviours | **4 238** lines | research 03 §9 |

Two more findings reshape the question rather than answer it:

- **"Full pi parity" is not one thing.** Upstream ships **three** independent
  harnesses: `pi-agent-core` (the loop), `pi-coding-agent` (82 285 LOC, terminal,
  Node-only) and `pi-durable` (35 802 LOC, transactional, and *state-first* — it emits
  documents and ops, and contains **zero** `AgentEvent`). `pi-coding-agent` and
  `pi-durable` do not depend on each other, and `pi-durable` does not even import
  `pi-agent-core` (research 03 §12).
- **A substitute core cannot satisfy pi's higher layers without `pi-ai`.** The binding
  is type-only — 37 of 40 import sites — but `AgentTool extends Tool<pi-schema>`,
  `AgentMessage = Message | …` and `StreamFn` over a **branded** `TranscriptContext` all
  point at pi-ai. The real contract is pi-ai, not pi-agent-core (research 03 §13).

## Decision

### D15. The core is **re-derived**, not ported — and upstream is the specification

> The budgets this decision is measured against, and the quality bar it is written
> to, are in [ADR 0004](./0004-quality-bar.md) D19–D22. The decisive measurement:
> upstream's agent core bundles to **22 923 B gzip** — 76 % of our 30 KB ceiling —
> so depending on it was never a close call.

The agent core is written for MiHa's job. Upstream pi is read as the **specification**,
and its **test suite** is the part that transfers.

The split, measured against upstream (research 03 §6):

| Part | LOC | What happens to it |
|---|---|---|
| **Pasted** | ~78 | `createErrorToolResult`, `createToolResultMessage`, the tool lifecycle emitters, `shouldTerminateToolBatch`, `withToolChanges`, the pending-message queue. Even these need renamed types |
| **Transcribed** | ~250–290 | the parallel and sequential executors, the prepared-call executor, the tool preparation pipeline, the truncated-message guard, the batch dispatcher. Control flow preserved, types re-derived |
| **Re-derived** | ~435–625 | the narrow type surface, the turn loop, the provider call and stream assembly, the tool-set diff, the state facade |
| **Total** | **≈ 765–995** code LOC | against upstream's 1 437 for the same territory |

Budget: **1 000 code LOC for the core**, with a per-module budget enforced the way
ADR 0002 D13 requires — a file count per entry point, plus a byte budget.

Consequences of re-deriving rather than copying:

- MiHa's types are its own. `AgentTool` carries a plain JSON Schema, not a
  `Static<TParameters>` derived from a schema library. That is the ~75 % reduction of
  the type surface, and it is what removes the coupling to pi-ai and pi-schema.
- MiHa's provider event type is thin — deltas, no whole-message `partial` snapshot on
  every variant. That is what lets the relay strip whatever it likes and shrinks the
  client-side reconstruction from 138 LOC to roughly 30–50 (research 03 §4).
- MiHa inherits **no** upstream defect and gains **no** upstream fix automatically.
  That is the price, and D16 is the mitigation.

### D16. Development order: the conformance suite first

The single highest-leverage transfer from upstream is not code — it is **4 238 lines of
browser-safe tests** that encode the sixteen non-derivable behaviours as executable
assertions, eight of which fail silently.

So the order is inverted from the usual:

1. **Port upstream's tests first**, re-pointed at MiHa's types, red against a stub.
2. Implement until they are green, function by function.
3. Only then add what MiHa needs that upstream does not have — the capability bridge,
   the peer exchange, the trace and record/replay.

The specific upstream behaviours to encode as assertions, because each is a silent
failure if re-derived from scratch (research 03 §8):

| Behaviour | Upstream assertion |
|---|---|
| a tool call from a `length`-truncated message is never executed | `agent-loop.test.ts:509` |
| every call in an aborted batch still receives exactly one result | `agent-loop.test.ts:1003`, `:1034` |
| `tool_execution_end` in completion order, tool results in source order | `agent-loop.test.ts:721` |
| one sequential tool forces the whole batch sequential | `agent-loop.test.ts:920`, `:1072` |
| the steering queue is polled at exactly three points | `agent-loop.test.ts:1581` |
| the tool loadout change is announced, with its three merge cases | `agent.test.ts:164`, `:212`, `:247` |
| a dropped provider connection is an error, not a hang | `proxy.test.ts:99` |

And two upstream behaviours MiHa must **not** inherit (research 03 §10):

- The error/aborted hard exit must not drop tool calls without results. Upstream is
  saved by pi-ai's payload repair; MiHa has no such net, and its transcripts cross a
  peer link.
- The raw loop entry point must always terminate. Upstream's `agentLoop()` has no
  `.catch()` and can leave the result promise pending forever.

### D17. "Parity" means interoperability, not feature parity — and the backend harness is a separate concern

The owner's instinct is right that the frontend case does not need pi parity. It is
also right that a fuller harness should be available. The mistake would be to pursue
parity as *feature parity inside the core*.

**Parity is redefined as interoperability on three axes:**

| Axis | What it means | How |
|---|---|---|
| Protocol | a pi-shaped host works against MiHa's core | the `AgentEvent` union keeps upstream's names and shape; the tool contract keeps upstream's field names |
| Data | a session written by one side is readable by the other | the entry format follows pi's JSONL session format, including the v1 and v2 shapes |
| Composition | pi's higher layers can sit on top | MiHa's core exports the same entry points pi's do — `Agent`, `agentLoop`, `runToolCall`, `setDefaultStreamFn` — with the same names |

That is what "the same MiHa runs on both sides" actually needs. It is not feature
parity, and it does not require pi's catalogue, OAuth, MCP, package manager or TUI.

**The full harness is a sibling package, and it is not the frontend's problem.**

| Layer | Where | Cost | Browser? |
|---|---|---|---|
| `miha` — the core | the browser | ≈ 765–995 LOC | yes |
| `miha-full` — sessions, compaction, skills, sub-agents, scope registry | wherever a full harness is wanted | ≈ 940 LOC | yes, with a host-owned store |
| Node-only parts | the backend peer | taken from upstream verbatim: `pi-mcp` (4 755 LOC, one dependency, depends on neither `agent` nor `ai`), the provider catalogue and OAuth from `pi-ai` server-side, storage backends from `pi-durable` | no, by construction |

The upstream extension system is **not** on this list, and deliberately so. It is a
Node module loader that executes arbitrary TypeScript in-process
(`coding-agent/src/core/extensions/loader.ts`, 904 LOC) — precisely the privileged
surface ADR 0002 D8 moves to the host. There is no browser-shaped equivalent, and
there should not be one. MiHa's two-list model — declared to the model, callable by
tools — is the browser-shaped replacement, at about 30 LOC.

**The backend may simply be pi.** Because the backend can afford 82 000 LOC and Node
dependencies, "build a full harness for the backend" and "depend on
`@earendil-works/pi-coding-agent`" are close to the same cost, and upstream's is
already tested. Upstream ships this split itself: `apps/p2` is a browser UI in front
of a `pi-durable` harness on a server.

If that is the choice, the boundary must be drawn honestly: the backend runs its
harness as an **independent service that speaks MiHa's exchange protocol at its
boundary**. Pointing the frontend's provider seam straight at pi-ai instead would make
MiHa's core a thin client for pi's type system — the coupling D15 exists to remove.
The other friction is structural: `pi-durable` is state-first and MiHa is event-first,
so a projection is needed between them (research 03 §15).

### D18. The JSON Schema validator is taken; the argument-streaming layer is not, yet

Two upstream pieces sit outside the core and need an explicit decision.

**The validator is taken whole.** `@earendil-works/pi-schema` is 4 852 LOC with **zero
runtime dependencies**, browser-safe, and passes 2 222 of 2 223 official conformance
tests. It is the one upstream package MiHa depends on — for **validation only**. MiHa's
types stay plain JSON Schema, so the schema library's `Static<T>` does not infect the
call sites; only the runtime check uses it.

**The argument-streaming layer is not taken in v1.** Upstream's
`pi-ai/src/utils/streaming-json.ts` is **559 LOC** of subtle, performance-sensitive and
security-sensitive parsing, and the ADR does not budget for it. In v1 MiHa keeps the raw
argument text and parses it **once**, at `toolcall_end`, with strict parsing and repair
— 40–70 LOC.

That choice has a second-order benefit: with strict final parsing, a truncated
argument simply fails to parse, so the truncated-call rule of D5 becomes trivially safe
rather than depending on the provider layer's salvage behaviour. What is forfeited is
**live partial-argument rendering** in the interface.

If a host needs that rendering, v1.1 vendors those two modules (≈ 620 LOC) as an
attributed dependency, or depends on pi-ai for exactly those modules.

## Consequences

**Positive**

- The core is roughly **half** of upstream's, in lines and in the type surface it drags
  in, and its shape is dictated by the frontend job rather than by a general-purpose
  harness's history.
- MiHa depends on **one** upstream package, for validation only, and is not coupled to
  pi-ai's `Model`, `Usage` or branded `TranscriptContext`.
- The dangerous behaviours are encoded as tests before they are implemented, so the
  eight silent failure modes are designed against rather than discovered.
- "Parity" no longer forces the frontend core to carry a catalogue, OAuth, MCP, a
  package manager and a TUI. It reduces to three interoperability commitments.
- The backend choice stays open: build a MiHa-side full harness (~940 LOC), depend on
  upstream's, or run both — decided when the backend harness is actually needed, not
  now.

**Negative**

- Re-derivation means MiHa carries the cost of upstream's edge cases **twice**: once
  reading them, once implementing them. D16's test-first order is what makes that
  affordable, but it is a real cost and it is paid in review attention.
- Upstream's future fixes do not arrive automatically. MiHa will need to track the
  upstream changelog for behavioural changes.
- Giving up live partial-argument rendering in v1 is a visible product limitation, not
  a hidden one.
- The interoperability commitment is a promise about names and shapes. If upstream
  renames a field, MiHa's promise is broken in a way that is not visible in a type
  error.

**Neutral**

- "Port" was the wrong word and the ADR now says "re-derived, with upstream's tests as
  the specification". Only about 78 LOC of upstream's code is pasteable anyway, because
  upstream's code is welded to pi-ai's types.
- The frontend core and the backend harness are now separate decisions with separate
  budgets. That is the main structural change from ADR 0002, and it is the owner's
  instinct made explicit.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Port upstream's core nearly verbatim | 2 126 LOC plus a hard dependency on pi-ai (29 094 LOC, ten runtime dependencies including four vendor SDKs) and pi-schema, for the type coupling at every call site. And the imported catalogue concerns — model cost tables, thinking levels, OAuth key resolution, provider attribution — are exactly what MiHa wants the host to own |
| Write a purpose-built core from first principles, upstream unread | The sixteen non-derivable behaviours, eight of them silent. A rediscovery of the truncated-call rule or the orphan-result repair produces a plausible, test-passing, wrong implementation |
| Re-derive, but also implement the argument-streaming layer in v1 | 620 LOC of subtle parsing that is not on the critical path, and whose absence has a cheaper alternative that is *safer* for the truncated-call rule |
| Keep pi's whole `pi-ai` as the provider layer | Ten runtime dependencies, four vendor SDKs, an OAuth implementation a browser must not hold, and a type contract that would make MiHa a thin client for pi's model |
| Pursue feature parity inside the core | That is what made ADR 0001 heavy: a portfolio of periphery — a catalogue, OAuth, MCP, a package manager, a TUI — that the frontend job never uses |
| Add an extension that delivers full pi parity | Upstream's extension system is a Node module loader executing arbitrary TypeScript in-process. There is no browser-shaped equivalent, and there should not be one. Parity as a sibling package is reachable; parity as an extension is a category error |
| Depend on upstream's `pi-coding-agent` for the frontend | 22 runtime dependencies, 135 node-builtin hits, and a terminal UI in the bundle |
| Build the backend harness on pi's packages, the frontend on MiHa's | Reachable and upstream ships an instance of it. The friction is two runtimes, two session models, two provider configurations, and a state-first/event-first impedance mismatch. Acceptable at the boundary, unacceptable as a type coupling |

## Out of scope for this ADR

- Which of the three backend options is taken: a MiHa-side full harness, upstream's
  packages, or both. That is decided when the backend harness is needed.
- The MCP client, the provider catalogue and OAuth — all backend-side, all available
  from upstream verbatim.
- The live partial-argument rendering, deferred to v1.1.
- The trace and cassette formats.

## Open questions for the owner

1. **Backend harness.** Do we build a MiHa-side `miha-full` (~940 LOC), depend on
   upstream's `pi-coding-agent` or `pi-durable`, or start with a MiHa-side harness and
   keep upstream as an option? The decision can wait until the backend needs one, but
   the exchange protocol has to be compatible with the eventual answer.
2. **Partial-argument rendering.** Is live streaming of tool arguments visible enough
   in the interface to justify 620 LOC in v1, or is v1's "parse once at the end"
   acceptable?
3. **Trace format.** Should the trace be the same shape as upstream's JSONL session
   format, so a pi-shaped tool can read it?
4. **Upstream tracking.** How far should MiHa track upstream's changelog — a manual
   review per release, or an automated diff of the upstream test suite against ours?
