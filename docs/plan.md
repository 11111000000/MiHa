# MiHa — the plan

One document, one question per section: what is being built, in what order, and how
will we know each piece is right. The decisions live in `docs/adr/`; this file is the
route through them.

## The shape

A **decentralised agent harness**: small enough to embed in any application, fast
enough to sit in a worker, and able to hand work to a peer agent and take it back.

```
frontend application          backend peer
┌───────────────────┐         ┌───────────────────┐
│  UI               │         │  data, compute,   │
│  ┌─────────────┐  │  offer  │  credentials      │
│  │ MiHa worker │◄─┼─────────┼─► MiHa            │
│  │  loop+tools │  │  event  │                   │
│  └─────────────┘  │◄────────┼─► call/answer     │
│  host bridge:    │         │                   │
│  DOM, storage    │         │                   │
└───────────────────┘         └───────────────────┘
```

## The five things that must be true

| # | Property | Where it is decided | How it is checked |
|---|---|---|---|
| 1 | **Small** — the browser bundle fits 30 KB gzip | ADR 0004 D19 | `bun scripts/check-budget.mjs` |
| 2 | **Correct** — every law has a derivation and a test | ADR 0004 D22, ADR 0005 D24–D28, ADR 0006 | `bun test` + the math-coding claims |
| 3 | **Simple** — the core performs no I/O, the run is a small state machine | ADR 0005 D24, D25 | the state machine has six states and no hidden control flow |
| 4 | **Functional** — the whole class of agent tasks: a loop with tools | ADR 0005 D26–D29 | the golden traces of the scenarios |
| 5 | **Decentralised** — a peer may hand work over and may call back | ADR 0005 D30 | the exchange conformance suite |

## The order of work

Each step states what it produces and what proves it right. Nothing starts before the
step above it is green.

### 1. The algebra, the stream, the dialect — **done**

`src/core/messages.ts`, `src/core/events.ts`, `src/core/event-stream.ts`,
`src/schema/dialect.ts`.

Proven by: laws S1–S5 and C1–C3, 23 tests, and a bundle of **1 907 B gzip** against
the 30 000 B ceiling.

### 2. The tool contract and the dispatch plan — **done**

`src/core/tools.ts` — the four-field contract, the registry, validation by the core,
the dispatch plan and its grouping. `src/core/permissions.ts` — the hook the host
fills. `src/core/json.ts` — parsing that cannot throw.

Proven by: laws M1, M2, M3 and the policy T1 — 19 tests covering an unknown tool, a
validation failure with a path, a truncated argument string, a salvaged fragment that
parses but does not validate, a throwing tool, a host that blocks a call, a host that
narrows a call's arguments, and an exclusive tool beside a shared one.

### 3. The transcript and the projection — **done, except compaction**

`src/core/transcript.ts` — 19 code lines. Append-only entries and the projection.
The core emits append intents and never touches storage; the host performs the append
and stamps the time. The compaction marker is still to come.

Proven by: laws T4 and the replay property — a run's transcript is a function of its
inputs, and re-running the same inputs produces the same transcript.

### 4. The state machine — **done**

`src/core/run.ts` — 441 code lines. Six states, `step(state, input) → {state, outputs}`.

Proven by: laws M1, M2, M3, M4 and T4 over a whole run — 8 end-to-end tests covering
a rejected tool, a throwing tool, a provider failure, the turn limit and cancellation.

### 5. The driver — **done**

`src/core/loop.ts` — 126 code lines. Performs the intents, feeds the inputs back,
races cancellation, merges abort signals without `AbortSignal.any`.

Proven by: the same end-to-end tests, driven through a scripted provider.

**One bug this slice found.** A batch whose calls were *all* rejected had no groups to
execute, so the driver had nothing to feed back and the batch never closed — the
rejections never reached the transcript. The fix is in the core, not the driver: a batch
with nothing to run is already answered, and closes where it was planned.

### 6. The provider layer — **done**

`src/llm/` — 306 code lines. The SSE reader, the tool-call correlation tracker, one
OpenAI-compatible adapter.

Proven by: two claims — `provider-never-throws` and `provider-arguments-intact` —
covering a network failure, a refusal, a malformed chunk, a stream that ends without a
terminal event, a record that arrives without a trailing newline, parallel calls
correlated by index, and a call whose id arrives late.

**Two lessons from this slice.** The claims were declared *before* the code, and the
method immediately earned its keep: two of the three controls did not match the code as
written, and the method reported them as *inconclusive* rather than as proofs. A control
that changes nothing is not a control, and only the method notices.

The second lesson: the architectural decision named a `protocol/` layer that the tree
never had. Nothing caught it until a check compared the decision with the tree. It does
now.

### 7. The worker host and the capability bridge — **the bridge is done**

`src/worker/bridge.ts` — 114 code lines. The capability bridge: the worker asks the
host for the things a worker cannot have — the DOM, the storage, the clipboard — and the
host answers.

Proven by: five claims — `bridge-closed`, `bridge-failures-are-values`,
`bridge-answers-the-caller`, `bridge-carrying-failures-are-values` and
`bridge-answers-once` — covering a capability that was not registered, one that throws,
one that rejects, two concurrent calls, a value the channel cannot carry in either
direction, and a call answered twice.

Still to do: the host that *owns* the worker — spawning it, forwarding the events to the
interface, and terminating it. That is the next slice.

**What this slice cost.** Three things the method caught that a test alone would not
have:

- The implementation let a broken channel raise out of the host, which in the
  application's thread is an unhandled rejection. The claim was refuted, the hole was
  closed, and the trail shows it.
- Two of the three controls named lines the code did not have, and the method reported
  them as *inconclusive* rather than as proofs.
- One control disabled the sending of the frame altogether, so every call hung and the
  verifier took a minute instead of a millisecond. A control that breaks the law by
  hanging is a bad control: it costs the whole run and says less than one that fails
  fast.

### 8. The peer exchange

`src/exchange/` — the frames, the transport, the reconnection.

Proven by: the exchange conformance suite, run against both sides — a task offered
from the frontend and answered by the backend, and the same in the other direction,
including a peer-initiated tool call answered by the delegator.

### 9. The trace and record/replay

`src/trace/` — the run record, the cassette, the replay mode. The transcript itself is
the trace: no second format.

Proven by: a recorded run replays to the same transcript; a diverging run is reported
as a divergence with the first differing input.

### 10. The interface layer — optional

`src/ui/` — the registry, the flat spec, the patches.

Proven by: a spec is rejected before rendering when it names an unknown component; the
same spec rendered twice gives the same tree.

## Where each piece is written down

| Decision | Document |
|---|---|
| the architecture: frontend-first, worker, symmetric peer | `docs/adr/0002-core-harness.md` |
| how much of pi to take, and what parity means | `docs/adr/0003-core-scope.md` |
| the quality bar and the budgets | `docs/adr/0004-quality-bar.md` |
| the core harness: state machine, tools, dispatch, exchange | `docs/adr/0005-core-harness.md` |
| the four decisions of the design pass | `docs/adr/0006-core-decisions.md` |
| what was read and measured | `docs/research/` |

## The method

Every claim is stated with a falsifier, checked by a machine, and proved to be
sensitive by a negative control that breaks it. The trail is in `.math/v5/`, the
specification in `spec.json`, and `mathc run` is the gate.

```sh
mathc run          # verdict, states, uncovered files, next action
mathc map          # the same, read-only
mathc next         # what to do next, and why
```
