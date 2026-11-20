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

### 3. The transcript and the projection

`src/core/transcript.ts` — append-only entries, the projection, the compaction marker.
The core emits append intents and never touches storage; the host performs the append
and stamps the time.

Proven by: laws T4 and the replay property — a run's transcript is a function of its
inputs, and re-running the same inputs produces the same transcript.

### 4. The state machine

`src/core/run.ts` — six states, `step(state, input) → {state, outputs}`.

Proven by: the laws stated as properties of `step`; a golden trace per scenario; and a
check that the reachable states contain no illegal pair of an unanswered call and a
settled turn.

### 5. The driver

`src/core/loop.ts` — performs the intents, feeds the inputs back, races cancellation.

Proven by: the same golden traces, driven end to end; and the cancellation property —
a cancelled run reaches `finished` and never leaves a call unanswered.

### 6. The provider layer

`src/llm/` — the SSE reader, the tool-call correlation tracker, the strict argument
parser, one OpenAI-compatible adapter.

Proven by: the adapter's conformance fixtures — a stream that ends without a terminal
event is an error, not a hang; the final frame may lack a newline; parallel calls are
correlated correctly.

### 7. The worker host and the capability bridge

`src/worker/` — the core in a worker, the main thread as host for DOM and storage, the
bridge as a closed set of capabilities.

Proven by: the bridge refuses a capability that was not registered; `worker.terminate`
ends a run that cannot be ended politely; the main thread stays responsive during a
run.

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
