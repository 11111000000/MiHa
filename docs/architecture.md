# MiHa — the final architecture

This is the architecture. It supersedes the drafts that led here
([target-architecture.md](./target-architecture.md) keeps the derivation by quality;
the ADRs keep the decisions). Everything below is what gets built.

It was formed by taking the working design apart once more and asking of every piece:
**does this earn its bytes?** Six things did not survive that question. They are listed
first, because what a design refuses is the honest part of it.

---

## 0. What the critical pass changed

| # | Before | After | Why |
|---|---|---|---|
| 1 | **two permission seams** — a synchronous `beforeToolCall` in the core's planner, and the host's policy around it | **one seam, async, in the driver**: the host supplies `approve(call) → Promise<allow \| deny \| rewritten args>`, asked before each tool runs | a synchronous hook cannot ask a human — and Genium's whole interaction *is* ask-the-user. A denial becomes an ordinary tool result, so the model reads it and recovers |
| 2 | **two vocabularies** — `AgentEvent` for the host, journal entries for the transcript | **one**: the journal entry *is* the durable event. Live streaming deltas are ephemeral and never persisted | the host, the trace, the session and the peer all read the same log; nobody translates |
| 3 | a separate trace format planned for the `trace/` layer | **none** — the trace *is* the journal. The cassette records only what the journal cannot: the provider's responses | one artefact to store, ship and replay |
| 4 | the tool received the whole call block, raw argument text included | the tool receives the call's **identity** (id, name) and the **validated arguments**; the raw text is the journal's business | a tool that can re-read the raw text can act on something the core never checked |
| 5 | the peer protocol carried `call`/`answer` frames | already removed (ADR 0007) — a peer gets a **task**, never a handle | every protocol in the field refuses callable handles; the measured cost of acting on unseen decisions is real |
| 6 | the `phase` was a field the core kept in step | **derived** from the journal's tail and the ephemeral state | resume, fork and replay then cost nothing, because there is no second state to reconstruct |

Two things were examined and **kept**, for the record: the `report` progress callback
(one parameter, part of the event vocabulary, used by long tools) and the `accept` frame
(three lines; it lets the delegator tell *slow* from *refused* before any event arrives).

---

## 1. What it is, in one paragraph

An application embeds MiHa and gets an agent loop. The model decides; the harness
dispatches the tools the application registered; the application's own interface renders
what happened. Everything that happens is one **journal** — an append-only log of durable
events — and everything reads from it: the model's context (a fold), the trace (the log
itself), the session (a prefix), and what a peer is handed (the same events). The core
is a pure function over that journal; a driver performs what the core asks; the host
owns everything privileged — the model, the policy, the storage, the screen, the
capabilities. The agent runs in a page, in a worker, on a server, or on several at once,
handing **tasks** across — never tools.

```
      the host (the application)              the run
┌────────────────────────────────┐   ┌────────────────────────────────┐
│ the provider client            │◄──┤ the driver                     │
│ the tools                      │◄──┤   asks approve() before tools │
│ approve() — may ask a human    │   │   prepareRequest() in flight  │
│ prepareRequest()               │   │   races the cancellation      │
│ persist() — the journal store  │◄──┤   emits live deltas (ephemeral)│
│ capabilities (DOM, storage)    │   ├────────────────────────────────┤
│ the peer link ──── task ──────┼──►│ the core: step(state, input)   │
│ the interface ◄─── the journal │   │   phase = f(journal tail)     │
└────────────────────────────────┘   ├────────────────────────────────┤
                                     │ the journal (durable, windowed)│
                                     │ the projection (fold → context)│
                                     └────────────────────────────────┘
```

---

## 2. The five parts

### 2.1 The journal — the only durable state

An append-only log of **durable events**. One log; nothing else is durable.

| Entry | Means |
|---|---|
| `message` | a user, assistant or tool-result message entered the run |
| `tool_call` | the model issued a call |
| `tool_result` | the call was answered — always, exactly once |
| `compaction` | a range collapsed into a summary; carries the first kept id |
| `change` | an earlier entry's *model-facing* view replaced; history untouched |
| `block` | a call was denied by policy; recorded so the model and the audit both see it |

The core keeps a **window** of it; the host persists the whole as entries are appended.
The window is what makes the memory law (R1) true: a thousand-turn run costs the same
resident memory as a ten-turn run, for a fixed window.

**Live deltas are not journal entries.** A text delta from the provider is ephemeral —
it exists to render, and the assembled message is the entry. Nothing that can be
recomputed from the log is stored twice.

### 2.2 The projection — the model's context, folded

A named fold `apply(state, entry) → state`, advanced **incrementally**, never re-run
from scratch. The model context is the fold's output; the journal keeps the evidence.

Compaction is not a feature of the core — it is a fold that collapses a range into one
summary entry. The same fold answers the replay law:

> **fold(replay(log)) ≡ fold(log)** — the same run, replayed, produces the same context.

That law is the check the development style needs, and it is a pure-function test with
no provider in it.

### 2.3 The core — a pure transition function

```
step(state, input) → {state, outputs}
```

No I/O, no clock, no storage, no policy. Its inputs are the run's inputs (a prompt, a
provider event, a tool result, a cancel). Its outputs are **intents** — *ask the
provider*, *run these tools*, *append this entry* — plus the ephemeral deltas it passes
through to the driver.

**The phase is derived, never stored**: `phase = f(journal tail, ephemeral)`. That is
why resume (fold and continue), fork (take a prefix) and replay are properties of the
log rather than features to build.

The core validates arguments against the dialect, plans the tool groups, and keeps the
pairing. It does not decide whether a tool *may* run — that is the host's promise,
delivered asynchronously.

### 2.4 The driver — performs the intents, decides nothing

The only effectful part. For each intent:

- **provider request** → pass it through the host's `prepareRequest` (one optional
  function: elide a stale result, switch the model for a turn, attach a deadline), then
  perform it and feed the stream back as inputs.
- **tool plan** → for each tool, **await `approve(call)`**. The host may ask a human; a
  denial becomes a `block` entry and an ordinary error tool result; a rewrite replaces
  the arguments. Then run the tool and feed the result back.
- **append** → hand the entry to the host's `persist`, and advance the window.

It races the cancellation throughout: an aborted signal ends the run at the next
boundary with every in-flight call answered.

The provider layer speaks the OpenAI-compatible wire, and **MiniMax-M3** is the model it
was measured against: its thinking arrives in a separate field only when asked for
(`reasoning_split`), its stream ends on a `finish_reason` rather than on `[DONE]`, and
its usage is counted in the wire's own spelling ([ADR 0014](./adr/0014-minimax.md)
D71–D76). What the first live capture broke is written down too: a delta is a string
and nothing else, a call that never identifies itself is reported rather than absorbed,
the usage of a turn is the largest report of each count, the options bag holds the
provider's knobs and cannot replace the adapter's fields, and the system prompt is the
first message of the wire ([ADR 0015](./adr/0015-provider-defects.md) D82–D90).

### 2.5 The interface layer

The agent may **draw**: a component registry (what the host's interface is made of), a
**flat spec** (what the agent asks for — data, never code), patches (the host's own
substitutions) and the tree the layer produces ([ADR 0016](./adr/0016-interface-layer.md)
D91–D98). A spec is refused before rendering when it names a component the registry does
not have or a property it does not declare, and the same spec always produces the same
tree. A refusal is a first-class event, not folded into the tool result (D98).

### 2.6 The peer, on both sides

The exchange is symmetric: the delegating side offers a task, and the **receiving
side** accepts it, runs it with **its own** tools, and sends the run's journal
entries back as they are written ([ADR 0011](./adr/0011-receiving-side.md)). A peer
gets a task, never a callable handle.

A **cassette** records the provider's responses under the hash of the request that
asked for them, and replays a run without a network ([ADR 0012](./adr/0012-cassette.md)).
The journal is the trace; the cassette holds only what the journal cannot.

### 2.7 The host surface — seven hooks, and nothing else

| Hook | The host provides | May not |
|---|---|---|
| `callProvider` | the model, the transport | see the core's state |
| `tools` | pure functions over validated arguments | widen a schema, re-parse arguments |
| `approve` | the policy — may ask a human | run a tool the core did not plan |
| `prepareRequest` | rewrite the request in flight — elide a stale result, switch the model for a turn ([ADR 0013](./adr/0013-request-seam.md) D70) | reorder the journal |
| `summarize()` | write a better digest of what the core collapsed ([ADR 0017](./adr/0017-tool-timeout-and-host-digest.md) D100) | rewrite the history |
| `persist` | where entries live | edit an entry |
| capabilities | what a worker may reach: the DOM, storage | grant past the realm's end |
| the peer link | a task, in either direction | call the other side's tools |

**A peer gets a task, never a capability.** The receiving side is `delegate()` read
from the other end plus `runAgent`: accept or refuse, run one's own agent on the task
with one's own tools, send one's events back — they are the same journal entries — and
end with a result.

---

## 3. A run, end to end

```
 1  the application calls runAgent(prompt)
 2  the core appends a `message` entry        → the host persists it
 3  the core emits a provider request         → prepareRequest → the provider
 4  the provider streams deltas               → ephemeral; the interface renders
 5  the stream ends                          → the core appends the `message` entry
 6  the core plans the tool groups           → an intent, not an action
 7  the driver asks approve(call)            → the host may ask a human
       denied  → a `block` entry + an error result; the model reads it
       allowed → the tool runs with the validated arguments
 8  results arrive in completion order       → the core records them in assistant order
 9  back to 3, until no calls and no queue  → or the turn limit, which is named
10  the outcome: completed | cancelled | failed | limit-reached
```

At every step, the model's world is legible: a constant tool list, exactly one answer
per call, errors that point at the argument, results that say when they were cut, and a
prefix that never moves.

---

## 4. The laws

Derived from protocol facts, each with its witness where it depends on the driver.

| Law | Statement | Derivation |
|---|---|---|
| **M1** | every call receives exactly one result — on denial, failure, truncation, provider error, cancellation | the provider rejects the next request whose call has no answer |
| **M2** | a call with incomplete arguments is never executed | the output limit truncates the argument stream mid-JSON |
| **M3** | a failed tool is a result carrying `isError` | the model must be able to read the failure and recover |
| **M4** | a provider failure is an event; M1 survives it | a request can fail at any point |
| **R1** | resident memory is O(window + context + one result), independent of run length | the windowed journal, the incremental fold, the bounded result |
| **T1** | an exclusive tool runs alone; shared tools around it still run together | "exclusive" means not interleaved with another exclusive tool |
| **T4** | results are recorded in assistant order | the transcript must replay |
| **replay** | fold(replay(log)) ≡ fold(log) | the context is a fold of the log |
| **S1–S7** | the stream's laws | the stream is the only live channel |
| **C1–C3** | the dialect's laws | the admission set is written down, not the implementation |

---

## 5. The five budgets

**The host sets the policy; the core enforces the law.**

The context's budget is the fourth one (ADR 0010): the core measures the folded
context, and when it is over the budget the range that does not fit is collapsed into
a digest the model is told is lossy. With it, the three terms of law R1 — the window,
the context, one result — are all bounded by a number.

| Budget | Limit | Set by | Enforced by | Default |
|---|---|---|---|---|
| bundle | 30 000 B gzip, browser, minified | us | the build fails | — |
| result | bytes per tool result | the host | the core truncates and announces | 8 192 B, head and tail kept ([ADR 0009](./adr/0009-policy-defaults.md) D50) |
| turns | per run | the host | the outcome says `limitReached` | 32 — twice the observed median task ([ADR 0009](./adr/0009-policy-defaults.md) D51) |
| context | bytes of text in the model's context | the host | the core collapses what does not fit ([ADR 0010](./adr/0010-context-policy.md) D54) | 128 KiB — twice a median task (D54) | — |
| memory | the resident window | the host | R1 | 64 entries, decided, enforced when the journal windows ([ADR 0009](./adr/0009-policy-defaults.md) D52) |

---

## 6. The modules

| Layer | Holds | Lines now | Projected |
|---|---|---|---|
| `core/` | the journal, the projection, the state machine, the driver, the tool contract | 1 006 | ~1 300 |
| `schema/` | the tool-parameter dialect | 258 | 258 |
| `llm/` | the SSE reader, the call tracker, one adapter | 328 | ~450 |
| `exchange/` | the peer protocol, both directions | 279 | ~350 |
| `worker/` | the capability bridge, the realm host | 181 | ~250 |
| `trace/` | the cassette — the provider responses only | 158 | ~180 |
| `ui/` | the registry, the flat spec, the patches, the tree | 407 | ~800 |
| | | **1 909** | **≈3 350** |

**Bundle: 8 102 B gzip for the core, 9 708 B with the provider layer** (measured by
`scripts/check-budget.mjs`), and **14 458 B** for the whole browser example in
`examples/browser/` — the page, the worker and the harness together. The ceiling is
30 000 B. Zero runtime dependencies.
Resident memory O(window + context + one result), by law.

---

## 7. What is deliberately absent

| Absent | Why |
|---|---|
| a model catalogue | the host owns the model |
| a permission engine | the host owns the policy; the core carries one async hook to it |
| a session store | the host owns it; the core appends by intent |
| progressive tool disclosure | the preregistered test found the hypothesis did not survive; a moving tool list breaks the prompt cache |
| programmatic tool calling | a code tool over page-local actions is arbitrary script in the user's page |
| a graph runtime | the laws are checked by substitution on a pure function |
| telemetry | a journal that replays is worth more than a metric that aggregates |
| callable peer handles | a peer acts on decisions it cannot see; the cost is measured |

---

## 8. What remains to build, in order

1. **The journal as durable events** — the entry union, the window, the envelope. R1
   depends on it; so does everything below.
2. **The projection** — the incremental fold, the replay law's test.
3. **The async `approve` seam** — replacing the core's synchronous hook; the
   human-in-the-loop gap closes here.
4. **The result budget and `prepareRequest`** — both small, both on the driver.
5. **The receiving side of the exchange** — `delegate()` from the other end.
6. **The cassette** — the provider responses, keyed by request hash; replay mode.
7. **The interface layer** — if the agent is to draw interfaces.
8. **A run in a real browser, against a real provider, over a real socket.**
