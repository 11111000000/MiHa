# MiHa — the plan

One document, one question per section: what is being built, in what order, and how
will we know each piece is right. The decisions live in `docs/adr/`; this file is the
route through them.

## The shape

An **embeddable agent harness**: small enough to embed in any application, fast
enough to sit in a worker. When the page is not enough, an optional peer layer hands
tasks to a backend instance of the same harness and takes the results back
([ADR 0020](./adr/0020-embeddable-first.md)).

```
frontend application          backend peer
┌───────────────────┐         ┌───────────────────┐
│  UI               │         │  data, compute,   │
│  ┌─────────────┐  │  offer  │  credentials      │
│  │ MiHa worker │◄─┼─────────┼─► MiHa            │
│  │  loop+tools │  │  event  │                   │
│  └─────────────┘  │◄────────┼─► offer/event/    │
│  host bridge:    │         │   result          │
│  DOM, storage    │         │  (optional peer)  │
└───────────────────┘         └───────────────────┘
```

## The five things that must be true

| # | Property | Where it is decided | How it is checked |
|---|---|---|---|
| 1 | **Small** — the browser bundle fits 30 KB gzip | ADR 0004 D19 | `bun scripts/check-budget.mjs` |
| 2 | **Correct** — every law has a derivation and a test | ADR 0004 D22, ADR 0005 D24–D28, ADR 0006 | `bun test` + the math-coding claims |
| 3 | **Simple** — the core performs no I/O, the run is a small state machine | ADR 0005 D24, D25 | the state machine has six states and no hidden control flow |
| 4 | **Functional** — the whole class of agent tasks: a loop with tools | ADR 0005 D26–D29 | the golden traces of the scenarios |
| 5 | **Optional** — the peer layer comes out; the harness stands alone in the page | ADR 0020 D106 | `bun test test/peer-optional.test.ts` |

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

(The permission hook is gone: it was synchronous, and it moved to the driver as the
asynchronous `approve` seam — ADR 0008 D44.)

Proven by: laws M1, M2, M3 and the policy T1 — 19 tests covering an unknown tool, a
validation failure with a path, a truncated argument string, a salvaged fragment that
parses but does not validate, a throwing tool, a host that blocks a call, a host that
narrows a call's arguments, and an exclusive tool beside a shared one.

### 3. The transcript and the projection — **done, and now a journal**

`src/core/transcript.ts` held append-only message entries and a trivial projection.
It is **gone**: the journal replaced it (step 3b).

Proven by: laws T4 and the replay property — a run's transcript is a function of its
inputs, and re-running the same inputs produces the same transcript.

### 3b. The journal as durable events — **done**

`src/core/journal.ts` — one append-only log of durable events, every entry carrying
a monotonic sequence and one version (ADR 0006 D39, ADR 0008 D45). Six kinds:
`message`, `tool_call`, `tool_result`, `compaction`, `change`, `block`. The model's
context is a **named projection**: a fold over the log, advanced one entry at a time.

The core keeps a **window** of the log resident (64 entries, ADR 0009 D52) and the
host holds the whole thing; the context is whole regardless, because it is folded
forward rather than recomputed from the entries the core still holds. That is law
R1's first half: the resident memory of a run does not grow with its length.

Three new inputs carry the host's policy into the log: `blocked` (a refusal, which
is the model's answer and the audit trail at once), `compact` (a range collapsed into
a summary) and `change` (an earlier entry's model-facing view replaced, the history
untouched).

Proven by: claims `journal-events` and `journal-window` — the fold, the replay law
(*fold(replay(log)) ≡ fold(log)*), the compaction, the change, the refusal, the
bounded window and the gapless sequence the host receives.

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

### 7. The worker host and the capability bridge — **done**

`src/worker/bridge.ts` and `src/worker/host.ts` — 181 code lines. The bridge lets the
worker ask the host for the things a worker cannot have — the DOM, the storage, the
clipboard — and the host owns the realm: it hands over the capabilities, forwards the
worker's events to the application, and ends the realm.

Proven by six claims. Five are about the bridge — `bridge-closed`,
`bridge-failures-are-values`, `bridge-answers-the-caller`,
`bridge-carrying-failures-are-values` and `bridge-answers-once` — covering a capability
that was not registered, one that throws, one that rejects, two concurrent calls, a value
the channel cannot carry in either direction, and a call answered twice. The sixth,
`worker-host-laws`, is about the host: the set of capability names the worker can reach
is exactly the set of own keys of the application's table, every event frame reaches the
application unchanged and in order, nothing is posted after the realm ended (including an
answer to a call that was in flight), and no exception from the worker, a capability or
the channel escapes into the application's thread.

**What this slice cost.** Five things the method caught that a test alone would not
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
- **A discriminator** then broke four more things the controls could not: the closed set
  leaked `Object.prototype`, a cancelled run answered one call twice, a provider failure
  mid-batch dropped the streamed call, and the external abort signal did nothing at all.
  Every one of those had a control, and every control was proven.
- A second discriminator found that the host's own guard was **dead code** — the bridge
  swallowed the worker's failure first, so the "never raises" evidence belonged to a
  different module. The claim's scope now names the bridge too.

That last point is the one to keep: a proven control says the verifier is sensitive to
*that* mutation. It says nothing about the mutations nobody thought of. A claim is
settled only after a discriminator has tried to break it — see
[docs/discriminator.md](./discriminator.md).


### 8. The peer exchange — **done, both sides**

`src/exchange/` — the frames, the delegating side, the **receiving side** and the entry
queue. The frontend offers a task; the backend's entries arrive in order. The receiving
side accepts a task, refuses one it will not take (and says why), runs it with **its
own** tools, sends the run's journal entries back as they are written, and ends with
the run's own outcome ([ADR 0011](./adr/0011-receiving-side.md)).

The wire carries the journal, not the live events: a delegated task is a fact in a
log, not a fact in a frame (ADR 0008 D45, D49).

Proven by: the claim `exchange-delegate-laws` — the offer is sent once, every event the
peer sends is forwarded in order, an unregistered tool is answered with a failure rather
than a crash, the permission hook applies **and its rewrite reaches the tool**, a
throwing tool is answered rather than crashing the delegator, a refusal becomes a
failure carrying the reason, every answer carries the call's own id, and a frame for
another task is not ours.

Still to do: the **receiving side** — the side that accepts a task, runs its own agent
on it, and calls back. The protocol is symmetric, so that side is this code read from
the other end.

### 9. The trace and record/replay — **the cassette is done**

`src/trace/` — the cassette: the provider's responses under the hash of the request
that asked for them, and the replay mode ([ADR 0012](./adr/0012-cassette.md)). The
journal itself is the trace: no second format ([ADR 0008](./adr/0008-final-architecture.md)
D46); the cassette records only what the journal cannot.

A request the recording does not hold is a **divergence**, and it is reported with the
request that diverged.

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
