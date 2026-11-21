# MiHa — the architecture

One document: what the thing is, how a run works, what the model experiences, where the
boundary with a peer lies, and what holds it together. The decisions live in
`docs/adr/`; the route through the work is `docs/plan.md`; how it is developed is
`docs/method.md`.

## What it is

A **small, embeddable harness for a decentralised agent**. An application embeds it, and
the application gets an agent loop: the model decides, the harness dispatches the tools
the application registered, and the application's own UI renders the events.

The agent may work in the browser or on a server — or both, talking to each other. The
same code is both sides. That is the "decentralised" part: the harness does not care
where the reasoning happens, and a task can be handed from one side to the other and
come back.

## The shape

```
   application thread                       worker realm
┌────────────────────┐   capability   ┌────────────────────┐
│  DOM, storage,     │◄─── bridge ───►│  the agent loop    │
│  the interface     │                │  the tools         │
│                    │                │  the provider      │
│  the peer link ────┼── offer ──────►│                    │
└────────────────────┘                └────────────────────┘
```

| Layer | Holds | Lines |
|---|---|---|
| `core/` | the message and event algebras, the tool contract and dispatch, the transcript, the state machine, the driver | 1 006 |
| `schema/` | the tool-parameter dialect and its validator | 258 |
| `llm/` | the SSE reader, the call-correlation tracker, the OpenAI-compatible adapter | 313 |
| `exchange/` | the peer protocol | 151 |
| `worker/` | the capability bridge and the host that owns the realm | 181 |
| `trace/`, `ui/` | the run record, the component registry and the interface spec | not written yet |

**5 103 B gzip** for the core, **6 523 B** with the provider layer, against a **30 000 B**
ceiling. Zero runtime dependencies.

## How a run works

The core is a **pure transition function**:

```
step(state, input) → {state, outputs}
```

It performs no I/O. It emits **intents** — `provider_request`, `tool_plan`, `append` — and
the driver performs them. Six phases:

```
idle → requesting → streaming → dispatching → settling → finished
```

The transcript is **append-only**; the model context is a **projection** of it. The
driver runs the tools — not the host — so a tool always receives the arguments the
dispatch validated, including any the permission hook rewrote.

## What the model experiences

This is the part that decides whether the harness works in practice, and it is the part
the evidence is sharpest about. The model is not a bystander to our architecture: it
reads what we give it and it changes what it does.

| What the model sees | The law that holds it | The evidence |
|---|---|---|
| **A small tool set, each with one stated purpose** | the registry is constant for the whole run | 856 real tools had a "smell" in 97.1 % of cases and 56 % never stated their purpose (arXiv:2602.14878) |
| **Sharp descriptions, not rich ones** | the tool's description is one sentence of purpose and the parameters that matter | augmenting descriptions bought +5.85 pp success but cost **+67.46 %** steps and regressed **16.67 %** of cases — removing examples never hurt |
| **A prefix that does not move** | the tools array never changes during a run | *"Adding or removing tool definitions mid-conversation invalidates that cache, and the resulting miss can cost more tokens than the definitions you removed"* (MCP client best practices) |
| **Arguments that are exactly what was asked for** | the core validates against our dialect and the tool receives the validated arguments | models send `"42"` for a number; a subset validator that does not coerce rejects it |
| **Errors that say where** | the dialect reports an RFC 6901 JSON Pointer to the offending node | a model can only fix an argument it can locate |
| **Exactly one answer per call** | law M1 | a missing answer makes the provider reject the next request |
| **Results that are bounded, and say when they were cut** | the core truncates and marks it, keeping the beginning and the end | unbounded results cost ≈3 350·N² cumulative tokens; the schemas amortise, the results compound |
| **An end that is reported** | the outcome distinguishes completed, cancelled, failed and limit-reached | real tasks take 16.2 turns and 17.4 tool calls (arXiv:2509.24002); a silent stop is indistinguishable from a finished one |

Together these are what "the model feels confident" means concretely: **the model never
meets an ambiguous state.** Every call is answered exactly once, every error locates
itself, every truncation announces itself, and the prefix it sees does not move under
it.

## The boundary with a peer

A peer may be **offered a task**, and may offer one back. A peer may **not** call the
other side's tools — that is a callable handle into a decision the peer cannot see, and
every protocol in the field refuses to send one (ADR 0007). The delegating side's tools
and reasoning stay private.

```
offer(task, context) → event* → result
```

The offer carries the task, the context and the protocol version — nothing about the
delegator's tools. A frame for another task is not ours; a frame we do not know is
ignored.

## What holds it together

Nineteen claims, each with a machine that decides and a control that proves the machine
can fail. Twelve of them are the laws of the code, and every law names the fact it
derives from (ADR 0004 D22). The rest are the budgets, the document graph and the gate
itself.

```
bun run check     # budget, documents, types, tests, evidence
mathc next        # what the map says is next
```

## What is deliberately not here

| Not here | Why |
|---|---|
| a provider catalogue | the host owns the model; the core has no notion of one |
| a permission engine | the host owns the policy; the core offers one hook |
| session storage | the host owns it; the core appends entries by intent |
| progressive tool disclosure | the preregistered test found the hypothesis did not survive, and a moving tool array breaks the prompt cache |
| programmatic tool calling | a code tool over page-local actions turns a declared tool list into arbitrary script in the user's page |
| a graph runtime | the laws are checked by substitution on a pure function |

## What is still missing

- The **receiving side** of the exchange.
- The **durable event log with fold projections** (ADR 0006 D39) — the next structural
  step, because it subsumes compaction and lets the trace and the exchange share one
  vocabulary.
- The **trace and record/replay**, which the development style needs to compare repeated
  runs.
- The **interface layer**, if the agent is to draw interfaces.
- A run **in a real browser**, against a **real provider**, over a **real socket**. Every
  measurement so far is on Bun and Node.
