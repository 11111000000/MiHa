# MiHa — the target architecture

The design this brief calls for: a **small, embeddable agent harness** for applications
that need an agent and must not be weighed down by one. Not a smaller copy of a
terminal harness, and not a framework — a **harness**, sized for the job.

Everything below is derived from two things: what an embedded agent actually has to do,
and what was measured about how models behave inside one.

---

## 1. The three sentences

**What it is.** A library an application embeds, which gives it an agent loop: the model
decides, the harness dispatches the tools the application registered, and the
application's own interface renders what happened.

**For whom.** Applications where the agent is a *part of the product* — it draws
interfaces, fills schemas, works with the page — rather than a chat window beside it.
The agent may run in the page, on a server, or on both at once, handing tasks across.

**What it guarantees.** The model is never surprised. Every call is answered exactly
once, every error says where it is, every truncation announces itself, and the world the
model sees does not move under it.

That last sentence is the product. The rest of this document is how it is kept.

---

## 2. The organising principle

An agent's behaviour is shaped by what the harness hands it. The literature is blunt
about it: on 856 real tools from 103 servers, **97.1 %** had at least one description
smell and **56 %** never stated their purpose (arXiv:2602.14878). Making descriptions
*richer* bought +5.85 pp of success and cost **+67.46 %** steps with **16.67 %** of
cases regressing. Meanwhile a single distractor degrades accuracy across all eighteen
models tested (Chroma's *Context Rot*), and a **shuffled** haystack beat a coherent one.

So the architecture is not organised by modules. It is organised by **what the model
experiences**, and every part of the design is justified by that.

---

## 3. The eight guarantees the model gets

| # | What the model sees | Why it matters | Held by |
|---|---|---|---|
| G1 | **A small, constant set of tools.** Each has one stated purpose and the parameters that matter | 97.1 % of real tool sets have description smells; 56 % never state their purpose | the registry is fixed for the run |
| G2 | **Sharp descriptions, not rich ones** — one sentence, the parameters, the failure modes, no examples | augmentation cost +67.46 % steps and regressed 16.67 % of cases; removing examples never hurt | the tool contract |
| G3 | **A prefix that never moves.** The tool list is identical on every request | *"Adding or removing tool definitions mid-conversation invalidates that cache, and the resulting miss can cost more tokens than the definitions you removed"* | the registry is constant; the journal is append-only |
| G4 | **Exactly the arguments that were asked for**, validated and coerced | models send `"42"` for a number; a validator that does not coerce rejects it | our dialect, seven kinds, coercion per node |
| G5 | **Errors that locate themselves** — an RFC 6901 JSON Pointer to the node | a model can only fix an argument it can point at | the dialect reports the path |
| G6 | **Exactly one answer per call** — never none, never two | a missing answer makes the provider reject the next request; a second one desynchronises the transcript | law M1, witnessed by the plan |
| G7 | **Results that are bounded and say so.** Truncation keeps the beginning and the end, and is announced | unbounded results cost ≈3 350·N² cumulative tokens; the schemas amortise, the results compound | the core truncates and marks it |
| G8 | **An end that is named.** Completed, cancelled, failed, limit-reached | a silent stop is indistinguishable from a finished one; real tasks run 16.2 turns and 17.4 tool calls | four outcomes, never one |

Everything in the architecture exists to keep one of these eight true.

---

## 4. Five parts, each with one job

```
   the application thread                     the worker realm
┌───────────────────────────┐   capability  ┌───────────────────────────┐
│ tools · capabilities      │◄─── bridge ──►│ the core                  │
│ the interface             │               │ the journal                │
│ the peer link ────────────┼─── task ─────►│ the projection            │
└───────────────────────────┘               └───────────────────────────┘
                                                ▲ intents          │ events
                                                └──────────────────┘
                                                   the driver
```

### 4.1 The journal — one append-only log of events

**One** log, and everything reads from it: the model's context, the trace, the session,
and what a peer is handed. Not four formats that agree by convention.

| Entry | Carries |
|---|---|
| `message` | one message |
| `tool_call` | a call the model made |
| `tool_result` | the answer to it |
| `compaction` | a summary and the id of the first kept entry |
| `change` | a replacement for an earlier entry's model-facing view |

Append-only buys four things at once: **resume** is a fold and a continue; **fork** is
a prefix; a **trace** is the log; and **the exchange carries the log** rather than a
second vocabulary of frames.

The journal is the past. The present — the stream being read, the calls in flight, the
queued messages — is the ephemeral part of the run's state, and it is small.

### 4.2 The projection — the model's context, derived

A **named fold** from the journal to the model's messages: `apply(state, event) → state`.

Compaction is not a special case of the core; it is a fold that collapses a range of
entries into one. That is why the core can be small: the context is not the core's
problem, it is a fold's.

A law worth having, and cheap: *fold(replay(log)) ≡ fold(log)*. The same run, replayed,
must produce the same context. That is the check the development style needs, and it is
a pure function test with no provider in it.

### 4.3 The core — a pure transition function

```
step(state, input) → {state, outputs}
```

No I/O. No clock. No storage. It reads the journal, folds it, and decides what should
happen next. Its outputs are **intents**: *ask the provider*, *run these tools*, *append
this entry*.

**The phase is not a field.** It is derived from the tail of the journal and the
ephemeral state — six states, but none of them is a variable the core has to keep in
sync. That is the difference between a state machine and a phase enum, and it is why
resume, fork and replay fall out for free.

The laws it keeps, each with the protocol fact it derives from:

| Law | Derivation |
|---|---|
| **M1** every call receives exactly one result | the provider rejects the next request whose call has no answer |
| **M2** a call whose arguments did not arrive complete is never executed | the output limit truncates the argument stream mid-JSON |
| **M3** a failed tool is a result carrying `isError` | the model must be able to read the failure and recover |
| **M4** a provider failure is an event, and M1 survives it | a request can fail at any point |
| **T1** an exclusive tool runs alone; shared tools around it still run together | "exclusive" means *not interleaved with another exclusive tool*, not *serialise the turn* |
| **T4** results are recorded in assistant order | the transcript must replay; the live view may follow completion order |

### 4.4 The driver — performs the intents, decides nothing

It calls the provider, runs the tools, appends the entries, and races the cancellation.
It holds no policy: what runs, in what order and in which group was settled by the core
before the driver saw it.

Two consequences worth having:

- **The driver runs the tools, not the host.** So a tool always receives the arguments
  the dispatch validated, including any the permission hook rewrote. Letting the host
  invoke the tool is how a hook's rewrite gets silently discarded — a real defect the
  method caught.
- **The host may rewrite the request in flight.** One optional function between "the core
  emitted a provider request" and "the host performs it". It is how an application
  elides a stale result, switches the model for one turn, attaches a deadline, or forces
  a compaction — without the core knowing any of that exists.

### 4.5 The host surface — three ways to plug in, and nothing else

| Seam | What the host provides | What it may not do |
|---|---|---|
| **Tools** | pure functions over validated arguments | widen the schema, re-parse the arguments, decide the grouping |
| **Capabilities** | the things a worker cannot have: the DOM, storage, the clipboard | run without a grant; a grant is revoked when the realm ends |
| **The peer** | a task, in either direction | call the other side's tools — that is a handle into a decision the peer cannot see |

**A peer gets a task, never a capability.** Every protocol in the field draws the line
the same way: A2A exchanges declarations and never reaches into the other party's
state or tools; MCP's one server→client operation asks for an LLM generation rather
than a tool call; AG-UI carries attribution without orchestration. Delegation is
symmetric in *tasks* and one-way in *capabilities* — the delegating side's tools and
reasoning stay private.

---

## 5. The four budgets

Everything unbounded is a bug waiting to be measured.

| Budget | The limit | Enforced by |
|---|---|---|
| **The bundle** | 30 000 B gzip, browser target, minified | the build fails above it |
| **The result** | bytes per tool result, the host's policy | the core truncates and announces the cut |
| **The turns** | per run, the host's policy | the outcome says `limitReached` |
| **The context** | tokens per projection | the projection's own accounting |

The byte budget and the layer budgets are checked by the build. The result budget, the
turn limit and the context are policies the host sets — but the **enforcement** is the
core's, for the same reason argument validation is: a tool left to police its own
output is a tool that will not.

---

## 6. The run, end to end

```
the application          the core                 the model          a tool
      │                     │                       │                 │
      ├─ prompt ───────────►│                       │                 │
      │                     ├─ provider_request ──►│                 │
      │                     │◄── text, tool_call ──┤                 │
      │                     │                       │                 │
      │                     ├─ tool_plan ─────────────────────────────►│
      │                     │◄── result ─────────────────────────────┤
      │                     │                       │                 │
      │                     ├─ provider_request ──►│                 │
      │◄── events ──────────┤◄── text ─────────────┤                 │
```

What the model experiences, in order: a **stable** tool list, **one** tool call, **one**
answer to it, an error that **points at the argument** if there was one, and a result
that **says so** if it was cut. Nothing arrives twice, nothing is missing, and the prefix
it saw last turn is byte-identical to the one it sees now.

---

## 7. The modules

| Layer | What it holds | Lines now | Lines projected |
|---|---|---|---|
| `core/` | the journal, the projection, the state machine, the driver, the tool contract and dispatch | 1 006 | ~1 300 |
| `schema/` | the tool-parameter dialect and its validator | 258 | 258 |
| `llm/` | the SSE reader, the call-correlation tracker, the argument parser, one OpenAI-compatible adapter | 313 | ~450 |
| `exchange/` | the peer protocol, both directions | 151 | ~350 |
| `worker/` | the capability bridge and the host that owns the realm | 181 | ~250 |
| `trace/` | the cassette and the replay | — | ~250 |
| `ui/` | the component registry, the interface spec, the patches | — | ~800 |
| | **total** | **1 909** | **~3 650** |

**Bundle: 5 103 B gzip now, ≈12–14 KB projected**, against a 30 000 B ceiling. Zero runtime
dependencies, because every dependency is a permanent cost on every install.

For comparison, the nearest thing in the field — a browser-safe agent core — bundles to
**22 638 B gzip**, three quarters of the ceiling before a worker host, a peer link, a
trace or an interface layer exists.

---

## 8. What the core refuses to know

| Not in the core | Why |
|---|---|
| the model catalogue | the host owns the model; the core has no notion of one |
| the permission policy | the host owns it; the core offers one hook and one place to apply it |
| where anything is stored | the core appends entries by intent; the host decides where they go |
| what a tool does | the core validates and dispatches; the tool is the host's |
| what a screen is | drawing an interface is a host capability |
| what time it is | the core has no clock |

---

## 9. What is deliberately absent

| Absent | Why |
|---|---|
| progressive tool disclosure | the preregistered test found the hypothesis did not survive; a moving tool list breaks the prompt cache; a dozen tools is not a problem |
| programmatic tool calling (code mode) | the sandbox is a dependency; and a code tool over page-local actions turns a declared tool list into arbitrary script in the user's page |
| a graph runtime | the laws are checked by substitution on a pure function; a runtime adds checkpoints and nodes nobody asked for |
| a permission engine | every host would have to reconfigure it |
| a session store | the host owns it |
| telemetry | a trace we can replay is worth more than a metric we can aggregate |

---

## 10. What is still open

- The **receiving side** of the exchange: the same code read from the other end.
- The **journal's envelope**: a sequence number and a schema version, or something
  smaller of our own.
- Whether a task should carry a **declaration** of what the delegate may act on — a page
  affordance list is not a capability, but it is a description of the delegator's world,
  which is what a peer needs in order to act correctly.
- The **result budget's default**, and the turn limit's default, until they are measured
  against our real tasks.
- A run in a **real browser**, against a **real provider**, over a **real socket**.
