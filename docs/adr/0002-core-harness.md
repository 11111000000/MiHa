# ADR 0002: MiHa core — a minimal browser-first agent harness with a symmetric peer

- **Status:** Proposed — D2 and D7 amended by [ADR 0003](./0003-core-scope.md); the rest stands
- **Date:** 2026-11-20
- **Owner:** petr p.b.kosov@yandex.ru
- **Supersedes:** [ADR 0001](./0001-core-architecture.md)
- **Research base:** [research 01](../research/01-reference-landscape.md), [research 02](../research/02-scenario-runtime-landscape.md)

> **Retracted framing.** An earlier version of this ADR described MiHa as a *runtime for
> scenarios written by an agent*, with an evaluation plane as a product component. That
> was a misreading. "We develop agents with an agent" is the **development style** for
> the applications we build — it is not part of MiHa's runtime and MiHa does not ship a
> scenario runner or an evaluation harness. What survives from that version is a set of
> findings about the browser (see [research 02](../research/02-scenario-runtime-landscape.md))
> and a decision that the **host** owns everything privileged.

## Context

### What MiHa is

MiHa is a **frontend agent harness**: a small library an application embeds so the
application can run an agent loop, call tools, and stream results to its own interface.
Genium and Geopulse are the target kind of application: rich domain products (genealogy,
travel) with a real agent embedded, where the agent fills structured data schemas,
produces tours, and builds trees.

MiHa is **frontend-first**, but it is built knowing that a backend agent exists and that
the two must be able to hand work to each other:

- The frontend agent hands a task to the backend agent when the work belongs on a server:
  heavy computation, data the browser does not hold, long-running jobs, credentials the
  browser must not see.
- The backend agent hands a task to the frontend agent when the work needs browser
  context: reading the rendered interface, driving the UI, using local storage, generating
  an interface on the spot.
- The same MiHa code runs in both places. The task exchange is **symmetric**: neither side
  is the master.

The library must therefore be small enough to embed in a real application bundle, cheap
enough to run many instances, and structured so that the frontend and backend sides
share one implementation rather than two dialects.

### What the research changed

Two research cycles examined opencode V2, upstream pi and its `oh-my-pi` fork, five
minimal JavaScript agent frameworks, four production provider layers, browser execution
isolation, runtime interface generation, and stochastic evaluation harnesses. The
findings that bear on this decision:

| Finding | Number | Consequence |
|---|---|---|
| Upstream `pi-agent-core` is browser-safe as published | 2 548 LOC · 6 files · 2 runtime deps · zero Node built-ins | **Port it, do not reinvent it.** ADR 0001's premise that no browser-safe core existed was wrong — it described the `oh-my-pi` fork, which reaches `node:fs` through a barrel dependency and carries a native addon |
| Upstream also ships a complete JSON Schema validator | `@earendil-works/pi-schema` · 0 deps · 8.5 KB min+gzip · 2 222 of 2 223 official conformance tests | **Do not hand-roll a subset validator.** It rejects valid schemas and will not coerce `"42"` → `42`, which models do send |
| The smallest working reference is a 327-LOC teaching agent | teenycode · one 5-field tool type · a 45-line loop | The discipline is achievable. The loop fits in a page of code |
| Every production framework re-implements pi's loop | openai-agents 25k LOC of loop machinery · adk-js 5.3k · AI SDK 15.3k · upstream pi 952 | There is no better loop shape. **Copy the loop, not the frameworks** |
| Provider seams are expensive | AI SDK seam ≈ 750 lines of request/response types; openai-agents 752-line file; adk-js bakes Gemini types into the envelope | **Nobody has a seam as small as a plain function.** That is the opportunity |
| A same-origin Worker is not a security boundary | measured: cookies, IndexedDB, CacheStorage, `importScripts` all shared with the page | The Worker is a **scheduling** boundary. Do not sell it as a security one |
| QuickJS-in-WASM is slower and heavier than plain JS | 4×–19× slower than V8 · 16 MiB linear-memory floor that never shrinks · `setMemoryLimit` does not bound the WASM footprint | **WASM is not on the critical path.** It is a containment tier, not a speed tier |
| Generative UI consensus | model selects from a registry and emits data, never code | When the host wants runtime interface synthesis, it is a **host capability**, not a core feature |
| Reproducibility is not a provider feature | OpenAI `seed` is deprecated and explicitly unguaranteed; Anthropic and Gemini expose no seed | **Record/replay** is the only determinism lever |

### What the owner has settled

- Language: **TypeScript, browser-first**.
- Topology: the core lives in the browser; a backend agent is an optional peer.
- In the browser, MiHa normally runs in a **Web Worker** so the interface never freezes.
  It may also run without one.
- WebAssembly is worth considering **only if it gives a real gain in performance or
  memory** over plain JavaScript in the worker.
- Owner identity for the math-coding journal: `petr p.b.kosov@yandex.ru`.

## Decision

### D1. One package, browser-first, minimal runtime dependencies

MiHa ships as a single npm package. Its modules are grouped into layers and the
dependency direction between them is fixed and enforced:

```
protocol/    types and pure helpers shared by everything: messages, events, tool
             contracts, model and stream options, session entries, exchange frames
   ↑
core/        the agent loop, the Agent facade, the event stream, tool resolution
             and dispatch, compaction
   ↑
{ worker, exchange, llm, tools }   placements and adapters that implement core-side
                                    interfaces
```

`protocol/` has no imports. `core/` imports only `protocol/`. Everything above imports
`core/` and `protocol/`. Nothing imports upward.

A single package rather than a workspace: the boundary that matters is browser versus
Node, and it is enforced against the bundle, not by package boundaries. A layer that
later needs an independent release cadence can be extracted without moving the layers.

**Zero runtime dependencies** for the core and the protocol. The one library we take is
the JSON Schema validator from upstream pi, which itself has zero dependencies.

### D2. The agent core is re-derived from upstream's specification, not ported

> Replaced by [ADR 0003](./0003-core-scope.md) D15 and D16. The short form: the core is
> written for MiHa's job, at a budget of **≈ 765–995 code LOC** against upstream's
> 1 437 for the same territory. Upstream is the **specification**, and upstream's
> **browser-safe test suite (4 238 lines)** is the part that transfers — ported first,
> red against a stub, then implemented until green.

Kept from upstream, with upstream's names, so a host written against pi keeps working:

- `agentLoop(prompts, context, config, signal, streamFn)` and `agentLoopContinue`, with
  `streamFn` a required positional parameter and a module-global `setDefaultStreamFn()`
  for the common case.
- The `AgentEvent` union, unchanged: `agent_start`, `agent_end`, `turn_start`,
  `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`,
  `tool_execution_update`, `tool_execution_end`.
- `AgentContext.tools` as a **plain array** — the array *is* the registry. There is no
  registry object.
- The entry points pi's higher layers use: `Agent`, `agentLoop`, `runToolCall`,
  `setDefaultStreamFn`.

Dropped: telemetry, in-band tool dialects, provider-native compaction, the session
manager, the permission engine, the fork's `fail()` on the event stream, and the
fork's `interruptible`/`deferrable`/`loadMode` tool flags.

MiHa's own type surface replaces upstream's: a plain JSON Schema on a tool rather than a
schema-library-derived generic, and a thin provider event without a whole-message
snapshot on every variant.

### D3. The event stream has no `fail()`

Upstream's `EventStream` has `push`, `end` and `result`. It has no stream-level failure
channel, and that is deliberate: a provider error is an assistant message with
`stopReason: "error"`, and the agent's `agent_end` carries it.

A second error channel would force every consumer to handle both. Errors are events.

### D4. The tool contract is small, and two lists describe it

The base contract is teenycode's, five fields:

```
{ name, description, parameters, execute }
```

plus the three things a real harness needs and upstream has:

- `executionMode?: "parallel" | "sequential"` — a two-value enum, per tool. Upstream's
  rule: parallel by default, sequential if **any** tool in the batch declares it.
- `label` — what the host renders.
- `prepareArguments` — a shim applied to raw arguments before validation.

Two lists, not per-tool flags, describe exposure:

- **declared** — offered to the model in the request.
- **callable** — reachable by other tools.

That is upstream's `pi-durable` distinction (`tools` versus `callable`), and it is the
minimum that lets a host hide a tool from the model while keeping it callable.

Tool results carry `content`, optional `details`, and `isError`. Both failure styles are
supported: throwing, and returning `isError: true`. The second keeps `details` for the
interface, which a throw discards.

### D5. Tool-call pairing, and the truncated-call rule

Non-negotiable, and both are cheap:

- **Every tool call receives exactly one tool result.** Unknown tools, validation
  failures, aborts, and provider errors included. Providers reject the next turn
  otherwise.
- **A tool call from a message whose `stopReason` is `length` is never executed.** Streamed
  arguments are salvage-parsed, so a truncated call can parse *and* validate while being
  silently incomplete. It is failed with an error result asking the model to re-issue.
- **Validation happens in the core, before dispatch**, against the tool's registered
  schema. The tool never parses its own arguments — that is how the fourth tool forgets.
- **The tool set may change mid-conversation**, and the change is announced to the model
  in a system message before the next request.

### D6. Permissions are a hook, not an engine

Upstream pi ships no permission system at all: the mechanism is a `beforeToolCall` hook
returning `{ block: true, reason }`. MiHa keeps that hook and adds nothing to it.

The host implements `allow` / `ask` / `deny` inside its own hook, using whatever rules
it already has. MiHa does not need a policy engine, and a policy engine in the library
would have to be reconfigured by every host anyway.

The one thing MiHa does add is that a blocked call is a first-class outcome, not a
silent no-op: it becomes a tool result the model can read.

### D7. Provider access is one seam, host-supplied

```
StreamFn(model, request, options) → AsyncIterable<ProviderEvent>
```

with upstream's obligation stated explicitly, because without it every adapter author
invents their own error convention and the pairing rule in D5 has no defined path:

> The provider **must not throw and must not reject** for request, model or runtime
> failures. Failures are encoded as protocol events and a final message with
> `stopReason: "error" | "aborted"`.

MiHa ships the reusable pieces a provider author needs, not the adapters:

| Ship | Approx. LOC | Why |
|---|---|---|
| `ProviderEvent` union and `ProviderRequest` type | 60 | the host invents nothing |
| an SSE line splitter | 50 | nobody should write an SSE parser twice |
| a tool-call correlation tracker | 120 | the AI SDK needed 534 lines for this; the problem is provider-independent |
| a partial-JSON parser | 80 | streaming tool arguments render correctly; upstream needed a dependency for it |

> Amended by [ADR 0003](./0003-core-scope.md) D18: the JSON Schema **validator** is taken
> from upstream whole (`@earendil-works/pi-schema`, zero runtime dependencies,
> browser-safe) and is MiHa's only upstream dependency — used for validation only, so
> that a tool's `parameters` stays a plain JSON Schema and the schema library's
> `Static<T>` does not infect call sites. The **argument-streaming** layer is the
> opposite decision: in v1 MiHa keeps raw argument text and parses it once at
> `toolcall_end` (40–70 LOC), which forfeits live partial-argument rendering but makes
> the truncated-call rule of D5 trivially safe. Vendoring upstream's 559-line
> incremental parser is a v1.1 option.

Plus **one** optional adapter, `miha/provider/openai-compat`, about 300 lines and
fetch-only with no SDK. OpenAI-compatible Chat Completions is the lingua franca and an
application needs a working default. There is no separate Anthropic adapter and no
separate proxy adapter: a first-party relay should speak the OpenAI-compatible dialect,
which makes the relay a base-URL change rather than a second adapter.

### D8. In the browser, MiHa runs in a Worker; the main thread is the host

(The full harness for a backend deployment, and what "parity" means across the two
sides, are decided in [ADR 0003](./0003-core-scope.md) D17.)

The core is environment-agnostic and runs anywhere. In a browser application the
default placement is a **dedicated Web Worker**, so a slow turn never freezes the
interface. Running on the main thread is supported and remains the simpler choice.

The worker holds the agent loop, the provider calls and the tools that need neither DOM
nor storage. The **main thread is the host** for everything that does:

| Host capability | Why it must be on the main thread |
|---|---|
| DOM reads and UI interaction | the worker has no `document` |
| `indexedDB`, `localStorage`, cookies | the worker has no access to them |
| file pickers, clipboard, geolocation | browser-only APIs |
| the interface renderer | the DOM lives here |

This is a capability bridge, and it is the same mechanism that serves D9. Every call
crosses as structured data, carries the run's `AbortSignal`, and the module set is
closed — a scenario or a peer cannot reach anything the host did not expose.

Two properties the placement must preserve, both measured on this machine:

- **`worker.terminate()` is the only guaranteed hard stop.** It is the only mechanism in
  the browser that frees a realm, its WebAssembly instance and its linear memory. The
  run's promise must never be awaited without racing it against cancellation, because a
  scenario awaiting something that never settles would otherwise hang the host silently.
- **A Worker is not a security boundary.** It shares the origin: cookies, IndexedDB,
  CacheStorage and `importScripts` are all reachable from it. MiHa does not claim
  otherwise, and the documentation says so.

### D9. Task exchange with a peer is symmetric and built in

The frontend agent and the backend agent hand tasks to each other. The protocol is the
same in both directions, so the backend side is not a second dialect of the frontend
side — it is the same code.

| Frame | Direction | Meaning |
|---|---|---|
| `task_offer` | either | hand a task, with context and the tools the peer may call |
| `task_accepted` / `task_rejected` | either | the receiving agent decides |
| `task_event` | either | the delegate's agent events, in the same `AgentEvent` union |
| `task_result` | either | the outcome |
| `host_tool_call` | either | **the delegate asks the delegator to run a tool** |
| `host_tool_result` | either | the result of that call |
| `task_cancel` | either | stop |

The `host_tool_call` inversion is what makes the exchange more than remote procedure
call. It is the mechanism behind "the backend agent hands a task to the frontend agent":
the backend agent asks, and the browser runs it — reading the interface, driving the UI,
using local state. The same frame travels the other way, which is what lets the frontend
agent ask the backend to run something it cannot.

The delegate's events arrive as ordinary `AgentEvent`s, so the receiving side renders a
delegated task exactly like its own.

`host_tool_call` routes through the **same** tool dispatch path as a local call, so the
host's `beforeToolCall` permission hook applies identically to a peer's request. A
remote agent must not be able to bypass a local permission rule.

Transport is an interface. The first implementation is a WebSocket, because the
application already has one; an in-process implementation covers the case where the same
MiHa runs on both sides of a boundary inside one process.

### D10. Storage is an interface; the host supplies it

The core defines the entry shape and a narrow `SessionStore` interface. It ships no
IndexedDB implementation: IndexedDB is a browser global, it belongs to the host
application, and Genium already has an offline queue and a sync engine that MiHa should
reuse rather than duplicate.

The entry format is **ours**: an append-only log of entries with a projection, not
pi's JSONL v3 tree. A copy of pi's format would carry pi's assumptions — a session
header, a `parentId` chain, and the entries upstream's tools expect to find. Ours is
what our exchange protocol and our trace need: entries that are immutable, a projection
that derives the model context, and nothing that presupposes a terminal harness.

The cost is stated plainly: a pi-written session is not a MiHa session. Reading one is
a small, isolated adapter, and it is not in v1.

Session branching, revert and MCP are **out of scope for v1**. Branching is cheap when
it is wanted, and MCP is a protocol with authentication, transport and schema
negotiation — about 1 300 lines before OAuth in the closest reference.

### D11. Traces and record/replay are runtime features, because the development style needs them

We build applications with an agent. Those applications are stochastic, and the way we
keep them stable is repeated runs and a comparison against a baseline. That process
lives outside MiHa — but MiHa has to make it possible, so it provides:

- **A trace.** Every run emits a structured record: the agent events, the tool calls and
  their arguments and results, the provider requests with their parameters, and the
  timings and token counts. One trace is what a coding agent reads when a generated
  application misbehaves.
- **Record/replay in front of the provider.** A `ModelClient` sits between the core and
  the provider, recording `(request hash → response)` into a cassette and able to replay
  from it. This is the only real determinism lever: `seed` is deprecated and explicitly
  unguaranteed in the OpenAI SDK, and Anthropic and Gemini expose no seed at all.

Without those two, "run it fifty times and compare" cannot mean anything reproducible.

### D12. Compaction is minimal, and cuts only where it is safe

The trigger is the provider-reported context occupancy against the model's context
window. When it fires, the core keeps the recent turns and replaces the rest with a
summary.

Two rules keep it safe:

- **Never cut between a tool call and its tool result.** The compaction boundary is
  found by walking backwards and never splitting a pair. This is the single most
  important algorithm in the area, and it is about sixty lines.
- **The compaction entry carries the tool checkpoint**, so a compaction cannot silently
  drop the tool declarations and leave the model calling tools that were withdrawn.

Tool results are truncated at the source, not at compaction time, so the context the
model sees is bounded before compaction is even considered.

### D13. The boundaries are enforced by tooling, not by convention

| Check | Mechanism |
|---|---|
| Browser safety | bundle each entry point for the browser target and assert, on the bundler **metafile**, which modules are present and which are absent. A regex scan is a lint, not a proof: it has false positives (`path` as a JSON-Pointer field name) and false negatives (`import(someVariable)`, which upstream itself uses) |
| Layer direction | a per-entry **file-count budget** plus a `forbid` list, counting only value imports. Upstream's own comment: *"one stray `export *` can silently make a narrow entry drag an entire barrel"* |
| Runtime dependencies | walk every source file with the TypeScript compiler API, resolving every `import`, `export`, dynamic `import()` and `require()`, and fail on anything undeclared |
| Node built-ins | no **statically analysable** `node:` import. A built-in may only be reached through a variable specifier behind a runtime guard — upstream's rule |
| Size | a **hard** size budget that fails the build, in the style of arrow-js's `build/size.mjs` |

A byte budget is gamed by minification; a file-count budget tracks the thing that
matters, which is how much code the browser must evaluate.

### D14. WebAssembly is adopted only where a measurement says it wins

The brief allows WASM if it gives a real gain over plain JavaScript in the worker. The
measurements say it does not, in the place it would first be reached:

- QuickJS-in-WASM is **4×–19× slower** than V8 on a scenario-like workload.
- Each WASM instance costs a **16 MiB linear-memory floor** that never shrinks, and
  `setMemoryLimit` does not bound it — a 16 MiB VM limit still reached the 2 GiB ceiling.
- The dominant costs in an agent turn are network time and model latency, which WASM
  does not touch.

So WASM is **not** the scenario VM and **not** the agent core. It stays a candidate for
the narrow hot spots: token estimation, parsing a large streamed payload, diffing for
the edit tool. The architecture must not block it — a tool that wants a WASM module
loads one and calls it — but nothing is committed to it up front.

## Consequences

**Positive**

- Small. The core is a trimmed port of 2 548 upstream lines; the whole library is
  roughly 3 500–4 000 lines and fits comfortably beside an application bundle.
- The frontend and backend sides are one implementation. A task that moves between them
  does not change shape, and the receiving side renders it with the same code that
  renders its own events.
- The peer cannot bypass local permissions: peer tool calls go through the same
  dispatch path.
- The application keeps its own stack. A React app uses its own components, its own
  state library, its own `fetch`. MiHa brings the loop, the tool contract and the
  exchange, not a framework.
- Traces and cassettes make an agent-written application testable, which is what the
  development style needs to be more than hope.

**Negative**

- Scenarios and tools cannot use npm packages. A tool that needs a real dependency calls
  a host capability instead. This constrains what the coding agent can write and needs
  a documented pattern.
- The Worker placement means DOM-touching tools pay a round trip. The bridge call is
  cheap (sub-millisecond in the measured QuickJS case; `postMessage` is comparable), but
  it is not free and it is not the same as running on the main thread.
- Symmetric exchange means MiHa carries a protocol on both sides. That protocol is the
  part most likely to be revised.
- The provider seam is deliberately minimal, so an application that wants a rich
  provider feature set will write an adapter. That is the intended trade: the seam is
  the extension point.

**Neutral**

- MiHa is a library, not a framework or a platform. It has no opinion about the
  application's state, storage, routing or rendering. That is the point of D1 and D10.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep ADR 0001's shape | The concept was right and the evidence was wrong. ADR 0001's citations all pointed at the `oh-my-pi` fork; upstream is smaller and already browser-safe. Its hand-rolled schema validator, three provider adapters and shipped IndexedDB store are each strictly worse than the existing alternative |
| Vendor upstream `pi-agent-core` unmodified | Affordable at 2 548 lines, but it drags `pi-ai` and `pi-schema` and a body of behaviour we do not want. Port the three files we need, pinned, with upstream's names preserved |
| Hand-write a JSON Schema subset validator | Rejects valid schemas, will not coerce `"42"` → `42`, and is a permanent correctness liability. Upstream's is complete, dependency-free, 8.5 KB and passes 2 222 of 2 223 official conformance tests |
| Ship three provider adapters | ~3 700 lines upstream for the same three formats, and the proxy adapter is a base-URL change away from the OpenAI-compatible one. Ship the seam and the reusable author primitives |
| Ship an IndexedDB store in the core | IndexedDB is a browser global, it belongs to the host, and Genium already has an offline queue and sync engine |
| `EventStream.fail()` | Two error channels is worse than one. Upstream has none; errors are events |
| A permission engine in the core | Every host would have to reconfigure it. A hook the host fills is enough, and it is what upstream does |
| QuickJS-in-WASM as the only execution tier | Loses on speed (4×–19×) and memory (16 MiB floor, never shrinks) and does not bound the WASM footprint anyway. It buys containment, which is not what this threat model needs |
| WASM as the agent core | Same objection, and additionally it does not compose with a JavaScript tool ecosystem |
| Run the agent on the main thread only | Simple, but a slow turn freezes the interface. The worker is the default; the main thread stays supported |
| Treat the backend as the master and the frontend as a thin client | The brief says the backend hands tasks to the frontend too — that is what browser context is for. A symmetric protocol keeps one implementation |
| MCP in v1 | About 1 300 lines before OAuth in the closest reference, for a capability the brief does not require |

## Out of scope for this ADR

- The delegate wire format in full detail.
- The trace format and the cassette format.
- The compaction summarisation prompt.
- The tool catalogue an application ships with.
- Session branching, revert, MCP, sub-agents, provider-native compaction.

## Open questions for the owner

1. **Worker by default, or main thread?** The brief says the worker is the usual case.
   Should MiHa ship a ready-made worker host, or only the capability bridge that an
   application wires up itself?
2. **The exchange transport.** Is a WebSocket enough, or does the backend peer need to
   reach a browser that is behind a proxy that does not hold a socket open?
3. **Credential scope.** When the frontend agent delegates to the backend, which
   credentials travel with the task? The default should be none, and the backend should
   hold what it needs.
4. **Naming.** "MiHa" as the package name, and a name for the exchange protocol.
5. **Math-coding scope.** The aim and scope of the standing specification were derived
   from the stage-1 instruction. Re-declare them with `mathc goal` if the reading is
   wrong.
