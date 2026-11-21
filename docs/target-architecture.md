# MiHa — the target architecture

The design this brief calls for. Not a smaller copy of a terminal harness, and not a
framework — a **harness**, sized for the job and measured against it.

The goal is stated as four qualities of the harness itself:

> **effective · reliable · small · frugal**

Everything below is derived from those four, from what an embedded agent actually has to
do, and from what was measured about how these systems behave. Where a number exists, it
is cited; where a choice is a judgment, it says so.

---

## 1. The four qualities, and what each one costs

### Effective

The harness does its job: the model decides, the tools run, the results come back, the
application sees what happened. Effectiveness here is not "the model is happy" — it is
**the loop completes the task at an acceptable cost in turns, tokens and time.**

The measured facts that decide it:

| Fact | Number | Consequence |
|---|---|---|
| a real task runs 16.2 turns and 17.4 tool calls | MCPMark, arXiv:2509.24002 | the loop must be cheap per turn, not clever per turn |
| unbounded tool **results** cost ≈3 350·N² cumulative tokens; schema filtering is linear at 21–57 K/turn | arXiv:2609.22114 | the results, not the schemas, are the cost centre |
| richer tool descriptions: +5.85 pp success, **+67.46 %** steps, **16.67 %** regressions | arXiv:2602.14878 | descriptions stay sharp; augmentation is not free |
| prompt caching cuts cost 41–80 % and TTFT 13–31 % | arXiv:2601.06007 | the prefix must not move |
| mutating the tool list mid-conversation invalidates the cache, "and the resulting miss can cost more tokens than the definitions you removed" | MCP client best practices | the registry is constant |

### Reliable

The harness keeps its promises when things fail — and things fail constantly: providers
drop, tools throw, arguments arrive truncated, users cancel. Reliability is not the
absence of failure; it is **the transcript staying true through every failure.**

What that means, concretely:

- **Every tool call receives exactly one result** — on rejection, on a tool failure, on
  truncation, on a provider error, on cancellation. Never none, never two.
- **A provider failure is an event**, never an exception that leaves a call unanswered.
- **A call whose arguments did not arrive complete is never executed** — it is answered
  with an error asking the model to re-issue.
- **A crash can be resumed.** The journal is the past; folding it and continuing is a
  resume, not a reconstruction.
- **A replay reproduces the context.** *fold(replay(log)) ≡ fold(log)* — the same run,
  replayed, produces the same model context. This is the check the development style
  needs, and it is a pure-function test.

### Small

The harness fits in an application, not the other way round.

| | MiHa (projected) | The nearest browser-safe core in the field |
|---|---|---|
| bundle, browser target, gzip | **≈12–14 KB** | 22 638 B — three quarters of the ceiling before a worker host, a peer link, a trace or an interface layer exists |
| runtime dependencies | **0** | 2 workspace packages plus one external |
| code | **≈3 650 lines** | 1 773 code lines in the core alone, but carrying a provider catalogue, thinking levels and cost tables we refuse to hold |

Zero dependencies is a design decision, not an accident: every dependency is a permanent
cost on every install and every audit.

### Frugal

**The core's resident memory does not grow with the length of the run.**

That is the law, and it is checkable. The mechanisms that keep it true:

| Mechanism | What it bounds |
|---|---|
| **A windowed journal.** The core holds a sliding window of entries; the host persists the rest as they are appended | the journal's resident cost |
| **An incremental projection.** The model context is folded forward, entry by entry — never re-folded from scratch | the projection's cost per turn |
| **A bounded result.** A tool result is truncated to a budget, the beginning and the end kept, the cut announced | the per-turn payload |
| **No snapshots per event.** The provider's stream yields deltas; the assembled message exists once | the streaming cost |

**R1 (the resident law):** the core's memory is O(window + context + current result) —
independent of the number of turns. A thousand-turn run costs the same resident memory
as a ten-turn run, for a fixed window.

This is where the research pays twice: the same mechanisms that bound the *token* cost
(the results) also bound the *memory* cost. The 3 350·N² term is both.

---

## 2. Five parts, each with one job

```
   the application thread                     the worker realm
┌───────────────────────────┐   capability  ┌───────────────────────────┐
│ tools · capabilities      │◄─── bridge ──►│ the core                  │
│ the interface             │               │ the journal (windowed)     │
│ the peer link ────────────┼─── task ─────►│ the projection (fold)     │
└───────────────────────────┘               └───────────────────────────┘
                                                ▲ intents          │ events
                                                └──────────────────┘
                                                   the driver
```

### 2.1 The journal — one append-only log

**One** log, and everything reads from it: the model's context, the trace, the session,
and what a peer is handed. Not four formats that agree by convention.

| Entry | Carries |
|---|---|
| `message` | one message |
| `tool_call` | a call the model made |
| `tool_result` | the answer to it |
| `compaction` | a summary and the id of the first kept entry |
| `change` | a replacement for an earlier entry's model-facing view |

The core holds a **window** of it; the host persists the whole. Append-only buys resume
(a fold and a continue), fork (a prefix), the trace (the log itself), and the peer
exchange carrying the same events rather than a second vocabulary.

### 2.2 The projection — the model's context, folded forward

A **named fold** `apply(state, event) → state`, computed incrementally. Compaction is
not a special case of the core; it is a fold that collapses a range of entries into
one. The context is not the core's problem — it is a fold's.

The fold obeys the reference-identity rule (an event the fold does not care about
returns the same state object, so nothing downstream republishes) and the replay law
(*fold(replay(log)) ≡ fold(log)*).

### 2.3 The core — a pure transition function

```
step(state, input) → {state, outputs}
```

No I/O, no clock, no storage. **The phase is not a field** — it is derived from the
tail of the journal and the ephemeral state, which is why resume, fork and replay fall
out for free.

Its laws, each with the protocol fact it derives from:

| Law | Derivation |
|---|---|
| **M1** every call receives exactly one result | the provider rejects the next request whose call has no answer |
| **M2** a call with incomplete arguments is never executed | the output limit truncates the argument stream mid-JSON |
| **M3** a failed tool is a result carrying `isError` | the model must be able to read the failure and recover |
| **M4** a provider failure is an event, and M1 survives it | a request can fail at any point |
| **R1** the resident memory does not grow with the run | the windowed journal, the incremental fold, the bounded result |
| **T1** an exclusive tool runs alone; shared tools around it still run together | "exclusive" means *not interleaved with another exclusive tool* |
| **T4** results are recorded in assistant order | the transcript must replay; the live view may follow completion order |

### 2.4 The driver — performs the intents, decides nothing

It calls the provider, runs the tools, appends the entries, races the cancellation. It
holds no policy: what runs, in what order and in which group was settled by the core
before the driver saw it.

- **The driver runs the tools, not the host.** So a tool always receives the arguments
  the dispatch validated, including any the permission hook rewrote.
- **The host may rewrite the request in flight** — one optional function between "the
  core emitted a provider request" and "the host performs it". That is how an application
  elides a stale result, switches the model for one turn, attaches a deadline or forces
  a compaction, without the core knowing any of that exists.

### 2.5 The host surface — three seams, and nothing else

| Seam | The host provides | What it may not do |
|---|---|---|
| **Tools** | pure functions over validated arguments | widen the schema, re-parse the arguments, decide the grouping |
| **Capabilities** | the things a worker cannot have: the DOM, storage, the clipboard | run without a grant; a grant is revoked when the realm ends |
| **The peer** | a task, in either direction | call the other side's tools |

**A peer gets a task, never a capability.** A2A exchanges declarations and never reaches
into the other party's state or tools; MCP's one server-to-client operation asks for an
LLM generation rather than a tool call; AG-UI carries attribution without orchestration.
Delegation is symmetric in *tasks* and one-way in *capabilities*.

---

## 3. The five budgets

Everything unbounded is a bug waiting to be measured.

| Budget | The limit | Who sets it | Who enforces it |
|---|---|---|---|
| **The bundle** | 30 000 B gzip, browser target, minified | us | the build fails above it |
| **The result** | bytes per tool result | the host | the core truncates and announces |
| **The turns** | per run | the host | the outcome says `limitReached` |
| **The context** | tokens per projection | the host | the projection's own accounting |
| **The memory** | the resident window | the host | R1 — the core's memory does not grow with the run |

The pattern is deliberate: **the host sets the policy, the core enforces the law.** A
tool left to police its own output is a tool that will not; the same holds for every
boundary the core owns.

---

## 4. What the model is handed

This is a *mechanism* serving effectiveness, not the goal itself: the loop completes
tasks at an acceptable cost when the model is given a world it can read.

| # | What the model sees | Why (measured) |
|---|---|---|
| 1 | a small, constant set of tools, each with one stated purpose | 97.1 % of 856 real tool sets had description smells; 56 % never stated their purpose |
| 2 | sharp descriptions — one sentence, the parameters, the failure modes | augmentation cost +67.46 % steps and regressed 16.67 % of cases |
| 3 | a prefix that never moves | caching cuts cost 41–80 %; a moving tool list invalidates it |
| 4 | exactly the arguments that were asked for, validated and coerced | models send `"42"` for a number |
| 5 | errors that locate themselves, by JSON Pointer | a model can only fix an argument it can point at |
| 6 | exactly one answer per call | a missing answer makes the provider reject the next request |
| 7 | results that are bounded and say so | unbounded results cost ≈3 350·N² cumulative tokens |
| 8 | an end that is named — completed, cancelled, failed, limit-reached | a silent stop is indistinguishable from a finished one |

---

## 5. What the core refuses to know

| Not in the core | Why |
|---|---|
| the model catalogue | the host owns the model |
| the permission policy | the host owns it; the core offers one hook |
| where anything is stored | the core appends by intent; the host decides where |
| what a tool does | the core validates and dispatches; the tool is the host's |
| what a screen is | drawing an interface is a host capability |
| what time it is | the core has no clock |

---

## 6. What is deliberately absent

| Absent | Why |
|---|---|
| progressive tool disclosure | the preregistered test found the hypothesis did not survive; a moving tool list breaks the cache; a dozen tools is not a problem |
| programmatic tool calling (code mode) | the sandbox is a dependency; a code tool over page-local actions turns a declared tool list into arbitrary script in the user's page |
| a graph runtime | the laws are checked by substitution on a pure function |
| a permission engine | every host would have to reconfigure it |
| a session store | the host owns it |
| telemetry | a trace that can be replayed is worth more than a metric that can be aggregated |

---

## 7. The numbers

| Layer | Lines now | Lines projected |
|---|---|---|
| `core/` — the journal, the projection, the state machine, the driver, the tool contract | 1 006 | ~1 300 |
| `schema/` — the tool-parameter dialect | 258 | 258 |
| `llm/` — the SSE reader, the call tracker, the adapter | 313 | ~450 |
| `exchange/` — the peer protocol, both directions | 151 | ~350 |
| `worker/` — the bridge and the host that owns the realm | 181 | ~250 |
| `trace/` — the cassette and the replay | — | ~250 |
| `ui/` — the registry, the interface spec, the patches | — | ~800 |
| **total** | **1 909** | **≈3 650** |

**Bundle: 5 103 B gzip now, ≈12–14 KB projected**, against a 30 000 B ceiling. Zero
runtime dependencies. Resident memory O(window + context + one result), by law.

---

## 8. What is still open

- The **receiving side** of the exchange: the same code read from the other end.
- The **journal's envelope**: a sequence number and a schema version, or something
  smaller of our own.
- Whether a task should carry a **declaration** of what the delegate may act on.
- The **result budget's default**, the **turn limit's default** and the **window's
  default** — all policies awaiting measurement against our real tasks.
- A run in a **real browser**, against a **real provider**, over a **real socket**.
