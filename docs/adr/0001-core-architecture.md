# ADR 0001: MiHa core architecture

- **Status:** **Superseded by [ADR 0002](./0002-scenario-runtime.md)** — kept as the decision trail
- **Date:** 2026-11-20
- **Owner:** petr p.b.kosov@yandex.ru
- **Supersedes:** —
- **Research base:** [docs/research/01-reference-landscape.md](../research/01-reference-landscape.md)

> **Why this was superseded.** The concept underneath this decision changed: MiHa is not a
> library that a frontend application embeds, it is a **runtime for programs written by
> an agent**, with an inner agent, runtime interface synthesis, delegation, and a
> stability harness. This ADR's agent core survives as one component of
> [ADR 0002](./0002-scenario-runtime.md) (decision D6).
>
> Two concrete defects were also found in this ADR after it was written; both are
> recorded in [Critique from research cycle 2](#critique-from-research-cycle-2) below.
> The first is material: **every `file:line` citation in this document points at the
> `oh-my-pi` fork of pi, not at upstream pi.** Upstream `pi-agent-core` is 2 548 LOC in
> 6 files with two runtime dependencies and **no Node built-in at all** — the premise
> under Context ("the published version reaches `node:fs` through a barrel dependency")
> described the fork, not upstream. The second: the hand-rolled JSON Schema subset
> validator proposed in D2 is strictly worse than the existing alternative.

## Context

MiHa (micro-harness) is a library, not an application. It embeds an agent core into a
frontend application so that the app can run an agent loop, call tools, and stream
results to its own UI. A backend agent may take over parts of the work; when it does,
it must be able to call back into tools the browser owns.

The product promise has two halves that pull against each other:

1. **Parity.** Functionally, MiHa must not be a toy. It must cover what opencode, pi and
   omp cover: streaming deltas, tool calling with schema validation, parallel tool
   execution, interruption, steering and follow-up queues, compaction, session
   persistence with branching, permissions, delegation.
2. **Minimality.** Memory and resource consumption are named as the decisive quality
   attribute. Code size, bundle size and dependency count are the levers.

The research in `docs/research/01-reference-landscape.md` produced three findings that
determine the shape of this decision:

- **No reusable browser-native agent core exists.** `peerd` (425★) is a browser-native
  harness but a product with actor/spawn/egress machinery, not a library.
  `@mariozechner/pi-web-ui` proves a pi agent can run in a browser, but the reusable
  kernel is not browser-safe as published.
- **Neither reference is browser-safe as shipped.** `pi-agent-core` reaches
  `node:fs` and `bun:sqlite` through the `@oh-my-pi/pi-utils` barrel and depends on a
  native addon. `opencode`'s `packages/core` has 54 files importing Node builtins and 65
  runtime dependencies, of which 19 are AI SDK packages.
- **The browser-safe parts are known and enumerable.** About 21.7k LOC of opencode V2
  and the whole of upstream `@mariozechner/pi-agent-core` (two dependencies) are reusable
  once Node-specific seams are cut out.

The owner has settled three forking questions:

- **Runtime:** TypeScript, browser-first.
- **Topology:** the core lives in the browser; a backend agent is an optional delegate.
- **Owner identity for the math-coding journal:** `petr p.b.kosov@yandex.ru`.

## Decision

### D1. TypeScript, browser-first

The core is written in TypeScript and targets the browser as its primary host. Node is
supported as a secondary host through the same interfaces, but no core module may depend
on a Node built-in.

Consequence: the browser is the forcing function. Anything that cannot work in a page —
spawning a process, reading a local directory, listening on a loopback port — is either
out of scope or moves behind a host-supplied interface.

### D2. One package, layered internally, zero runtime dependencies

MiHa ships as a single npm package. Inside it, modules are grouped into layers and the
dependency direction between them is fixed and enforced:

```
protocol/    types and pure helpers shared by everything (messages, events, tool
             schemas, session entries, commands, model and stream options)
   ↑
core/        the agent loop, the Agent facade, the event stream, the tool registry,
             permission rules, compaction
   ↑
llm/  store/  tools/  transport/     adapters that implement core-side interfaces
   ↑
ui/          framework-agnostic view-model helpers for rendering a session
```

`protocol/` has no imports at all. `core/` imports only `protocol/`. Adapters import
`core/` and `protocol/`. `ui/` imports `core/` and `protocol/`. Nothing imports upward.

A single package rather than a workspace: the browser-boundary property is enforced by a
bundler test on one entry point, and splitting into six packages would add workspace
plumbing without changing the boundary. If a layer ever needs an independent release
cadence, it can be extracted without changing the layer boundaries.

**Zero runtime dependencies.** The core, the protocol layer and the shipped adapters use
no npm packages. JSON Schema validation is implemented in-tree in `src/schema/` as a
deliberately small subset validator (object/array/string/number/boolean/enum/required/
additionalProperties), and validation is also injectable so a host that already owns
TypeBox or Zod can pass its own function.

### D3. The core is a pure function that returns an event stream

```
agentLoop(prompts, context, config, signal?, streamFn?) → EventStream<AgentEvent, AgentMessage[]>
```

The core holds no mutable session state. `Agent` is a thin facade over the loop that
owns the message list, the steering and follow-up queues, and an `AbortController`.

`EventStream` is an async-iterable queue with `push`/`end`/`fail` and a `result()`
promise. It is the single primitive that carries progress to the host, and it is the
only mechanism by which the core communicates.

This shape is taken from `pi-agent-core` (`agent-loop.ts:526-532`) because it makes the
core testable without a host, replaceable without a fork, and embeddable without a
server.

### D4. Everything privileged belongs to the host

The core owns no tool, no system prompt, no credential, no permission policy, no
persistence and no rendering. The host supplies them:

| Concern | Core's role | Host supplies |
|---|---|---|
| Tools | registry, resolution, dispatch, concurrency | the tool implementations |
| System prompt | carries `string[]` in the context | the content |
| Credentials | `getApiKey(model)` hook | the key and its storage |
| Permissions | `allow`/`ask`/`deny` evaluation, ask-callback | the decision and the saved rules |
| Persistence | entry types and the store interface | the store implementation |
| Rendering | nothing | the UI |
| Model catalogue | `Model` type and the resolution seam | the catalogue |

This is the single most transferable decision from pi, and the reason a 2–3k LOC core
can claim parity with a 33k LOC one: the missing kilobytes are supplied by the host
application, which already needs them.

### D5. Provider access goes through one seam

The core never speaks to a provider. It calls a `StreamFn`:

```
(model, context, options) → AssistantMessageEventStream
```

MiHa ships adapters for OpenAI and Anthropic wire formats, plus a proxy adapter that
talks SSE to a first-party relay and strips cumulative message snapshots from the
stream (the technique in `pi-agent-core/src/proxy.ts:97-212`, worth roughly 50% of the
stream bytes). A host that already has an LLM client passes its own `StreamFn` and
MiHa's adapters become dead weight that tree-shaking removes.

The in-band tool-call dialects, provider-native compaction, OAuth broker and quota
systems found in `pi-ai` are not ported. They serve dozens of providers; a micro-harness
serves one model at a time through one seam.

### D6. Persistence behind a store interface, in an interoperable format

`SessionStore` is an interface: append entries, read a branch, read one entry. MiHa
ships an in-memory implementation and an IndexedDB implementation. The entry format is
the JSONL entry format documented by pi (`session-format.md`): a tree of entries linked
by `id`/`parentId`, with `message`, `compaction`, `model_change` and `custom` entry
types, plus session headers.

The format is chosen for interoperability: a session written by MiHa should be readable
by pi and by opencode's session tree, and the branching semantics should match. The
append-only property matters beyond interop — it is what lets an append-only event log
plus in-memory projection replace SQLite.

### D7. Delegation to a backend agent is a transport, not a mode

The core can hand a task to a remote agent and merge the remote events into the local
event stream. The mechanism is a `DelegateTransport` interface with a WebSocket
implementation, carrying JSON commands and events.

Two properties are required of any transport:

- The remote agent may call **host tools** — tools that live in the browser. The wire
  format carries a `host_tool_call` request and a `host_tool_result` response, the same
  inversion pi's RPC mode uses (`rpc-types.ts:446-485`).
- The local session stays the source of truth for anything the browser owns; the remote
  agent's output is a stream of events like any other.

Delegation is optional and additive. MiHa without a delegate is a complete harness.

### D8. Browser safety is enforced by tooling, not by convention

Two checks run in CI and are the source of the math-coding claims:

1. **Static scan.** No module under `src/protocol/` or `src/core/` may import a Node
   built-in, reference `Bun.*`, `process.*`, or reach `window`/`document`/`localStorage`.
2. **Bundler boundary test.** The core entry points are bundled with the browser target
   and the bundle is asserted to contain no Node built-in shim. This is the technique
   opencode uses in `packages/client/test/import-boundaries.test.ts:14-30`, and it is
   the only check that actually proves the property rather than restating it.

A third check enforces the layer direction from D2 by parsing imports.

### D9. The event schema is the public contract

`AgentEvent` is the union of `agent_start`, `agent_end`, `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`, `tool_execution_start`,
`tool_execution_update` and `tool_execution_end`. It is taken from pi
(`pi-agent-core/src/types.ts:864-885`) with the same names, so a host written against
pi's event stream works against MiHa's.

Two invariants are non-negotiable and will be tested explicitly:

- **Pairing.** Every emitted `toolCall` block receives exactly one `toolResult`
  message, including on abort, on truncation and on provider error. Providers reject
  the next turn otherwise (`agent-loop.ts:1314-1369`).
- **Errors are results.** A tool that fails throws; the loop converts the throw into a
  tool result with `isError: true`. A tool never returns an error as ordinary content.

### D10. What "parity" means for MiHa

Parity is a feature list, not a line count. MiHa claims parity with opencode/pi/omp on:

| Capability | Source of the design |
|---|---|
| Streaming text, reasoning and tool-call deltas | `AssistantMessageEvent` |
| Tool calling with schema validation | `AgentTool` + the in-tree validator |
| Tool pairing and error semantics | D9 |
| Parallel tool execution with exclusivity | `agent-loop.ts:2776-2802` |
| Tool cancellation | `AbortSignal` in the execute signature |
| Steering and follow-up queues | `types.ts:236-288` |
| Compaction | `compaction.ts`, simplified |
| Session persistence, branching, revert | pi's JSONL entry format |
| Permissions with `allow`/`ask`/`deny` | `core/src/permission.ts` |
| MCP over streamable HTTP | `mcp.md` — optional |
| Tool exposure levels (direct/deferred/hidden) | `mcp.md:189-224` |
| Prefix-cache-stable prompt and tool prefix | `append-only-context.ts` |
| Delegation to a remote agent | D7 |

MiHa explicitly does **not** claim parity for: sub-agents, task trees, LSP, MCP over
stdio, PTY, git integration, file watching, npm package management, shell execution,
provider-native compaction, in-band tool dialects, telemetry, session sharing to a
cloud service. These are either impossible in a browser or belong to a full harness.

## Consequences

**Positive**

- The bundle stays small. A target of under 30 KB gzipped for the core plus adapters is
  plausible against the 2–3k LOC budget, and it depends on nothing at runtime.
- Memory use is a function of the session, not of the framework. The core holds a
  message list and a queue.
- The host keeps its own stack. A React app uses its own components, its own state
  library, its own `fetch`.
- Parity gaps are closed by the host rather than by forking the harness.
- The same core runs in Node, in a web worker, and in a service, because the browser
  is the strictest target.

**Negative**

- The host must supply a system prompt, a tool set and a credential policy before
  anything runs. A "hello world" is longer than in a monolithic harness.
- Two JSON Schema worlds: MiHa validates tool arguments in-tree with a small subset
  validator. Tools authored against full JSON Schema may need the injection seam.
- Sessions written by MiHa are readable by pi-style tools, not by opencode's SQLite
  schema. Round-tripping with opencode is out of scope.
- Delegation adds a protocol to maintain, and it is the part of MiHa most likely to be
  revised.

**Neutral**

- A single package with internal layers is unusual for a project of this ambition. It is
  a deliberate trade: the boundary that matters (browser vs Node) is enforced by the
  bundler test, not by package boundaries.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Fork opencode V2 and strip Node parts | 33k LOC, Effect, Drizzle and SQLite are structural, not incidental. Stripping them is a rewrite with worse documentation. |
| Fork `pi-agent-core` | The smallest available kernel, but the published version reaches `node:fs` through a barrel dependency and carries a native addon. Upstream `@mariozechner/pi-agent-core` has only two dependencies, and a browser-safe subset of it is a legitimate source — which is what D3, D4 and D5 encode. |
| Use `@mariozechner/pi-ai` as the provider layer | Eleven dependencies, including AWS Bedrock and Mistral SDKs, for a harness that talks to one model at a time. The `StreamFn` seam reproduces the useful part at a fraction of the weight. |
| Use the Vercel AI SDK | The most popular choice, and the one opencode itself used in V1. `streamText` is server-shaped, the dependency tree is large, and the provider-neutral event model MiHa needs is not its model. |
| Rust or Zig compiled to WebAssembly | Smallest possible binary, and the memory argument is real. The cost is the JS/WASM boundary on every tool call, a browser toolchain, and slower iteration on the part of the system that changes most. TypeScript was chosen for that reason, not for bundle size. |
| A monorepo of six packages | Workspace plumbing without a stronger boundary. Reconsider if a layer needs an independent release. |
| Implement the parity gaps too (LSP, PTY, subagents) | These are the reasons full harnesses are large. Shipping them would defeat the minimality half of the promise. |

## Out of scope for this ADR

- The tool catalogue MiHa ships by default.
- The delegation wire format in full detail.
- The compaction strategy and its token estimator.
- The host-side UI component set.
- Naming and packaging of the npm distribution.

## Open questions for the owner

1. **Default provider path.** Should the default configuration target a first-party
   relay (MiHa ships the proxy adapter) or assume a host-supplied `StreamFn`? The
   first makes MiHa usable in one line; the second keeps credentials in the host.
2. **Session storage default.** IndexedDB, or `localStorage` for small sessions with
   IndexedDB above a threshold?
3. **Tool catalogue size.** Which tools ship enabled by default, given that every
   declared tool costs prompt tokens on every request?
4. **Naming.** "MiHa" as the npm package name, or a different scope?

---

# Critique from research cycle 2

Recorded after [research 02](../research/02-scenario-runtime-landscape.md), so the
reasoning trail is preserved rather than rewritten. Each item names what this ADR said,
what the evidence showed, and the correction.

## Material defect — every citation points at the wrong repository

This ADR cites `pi-agent-core/src/types.ts:864-885`, `agent-loop.ts:526-532`,
`agent-loop.ts:1314-1369`, `agent-loop.ts:2776-2802`, `types.ts:236-288`,
`proxy.ts:97-212`. Those line numbers exist only in the `oh-my-pi` fork, which was the
copy on disk at the time. Upstream `earendil-works/pi` `packages/agent` is 6 files:

| Upstream file | LOC | Real location of what this ADR cited |
|---|---|---|
| `agent-loop.ts` | 952 | `agentLoop` signature at `:47-70` (not `:526-532`) |
| `agent.ts` | 623 | `AgentEvent` union at `types.ts:528-551` (not `:864-885`) |
| `types.ts` | 551 | tool pairing at `agent-loop.ts:488-513` / `:716-732` (not `:1314-1369`) |
| `proxy.ts` | 397 | parallel execution at `agent-loop.ts:518-533` (not `:2776-2802`) |

Four files this ADR cites **do not exist upstream at all**:

- `core/src/permission.ts` — upstream pi ships **no permission system**
  (`README.md:90`). Permissions are an extension hook, `pi.on("tool_call", …)` returning
  `{ block: true, reason }`.
- `append-only-context.ts` — the real mechanism is
  `resolveTranscriptTools(messages, support)` with `support ∈ {"none","additions","changes"}`
  (`packages/ai/src/utils/transcript.ts:230`, `:252-263`).
- `rpc-types.ts:446-485` with `host_tool_call` — upstream's RPC file is 303 lines and
  contains no host-tool inversion. That idea came from the fork and is an original
  design here, not a port.
- `compaction.ts` inside the core — upstream's compaction lives in `pi-coding-agent` and
  `pi-durable`, not in `pi-agent-core`.

The size of the upstream also reframes the budget: the "1 900–2 600 LOC" estimate in
Context was derived from the fork's 15 965 LOC and is pessimistic for the upstream.

## Material defect — the hand-rolled schema validator

D2 proposes implementing JSON Schema validation in-tree "as a deliberately small subset
validator". Upstream already ships `@earendil-works/pi-schema`: a **complete
draft-2020-12 + draft-7 validator**, zero runtime dependencies, **8.5 KB** min+gzip, no
`eval`, compiling schemas into plain closures, with coercion, JSON-Pointer error paths,
and **2 222 of 2 223** official JSON-Schema-Test-Suite tests passing
(`packages/schema/README.md:1-12`).

A subset validator rejects valid tool schemas and will not coerce `"42"` → `42` — which
models do send (`packages/ai/src/utils/validation.ts:47-49`). It is a permanent
correctness liability. **Correction:** depend on it or port it; the injection seam
remains, but as the secondary path.

## Other corrections carried into ADR 0002

| This ADR | Correction |
|---|---|
| D3 — `EventStream` with `push`/`end`/`fail` | Upstream has no `fail()`. Errors are events. Two error channels is worse than one. |
| D3 — `agentLoop(prompts, context, config, signal?, streamFn?)` | Upstream's `streamFn` is a required 5th positional; optionality comes from a module-global `setDefaultStreamFn()` (20 LOC). |
| D4 — "System prompt: carries `string[]` in the context" | Upstream's `AgentContext` has **no** system prompt field. The prompt and tool declarations live in the transcript's system messages, as replayable sections with tool-set deltas. A `string[]` throws that away. |
| D5 — "MiHa ships adapters for OpenAI and Anthropic wire formats, plus a proxy adapter" | ~3 700 LOC of wire code upstream, and the proxy adapter is a base-URL change away from the OpenAI-compatible one. Ship the seam and the reusable author primitives; at most one optional adapter. |
| D6 — "MiHa ships an in-memory implementation and an IndexedDB implementation" | Contradicts D3 and D4, and D8's own static scan (IndexedDB is a global). Keep the interface, drop the implementations. |
| D8 — static regex scan for Node built-ins | A regex is a lint, not a proof: false positives (`path` as a JSON-Pointer field name) and false negatives (`import(someVariable)`, which upstream itself uses). Replace with bundler metafile assertions, per-entry file-count budgets, and a runtime-dependency audit via the TypeScript compiler API. |
| D9 — "Permissions with allow/ask/deny" | MiHa does not need a permission *engine*, only a permission *hook* the host fills. Keep the three-way policy, anchor it on upstream's `beforeToolCall` shape. |
| D10 — tool exposure levels "direct/deferred/hidden" | Upstream has five levels and they are a registry concept, not per-tool flags: `direct`, `model-only`, `codemode`, `deferred`, `hidden`. Minimal version: two lists, `tools` (offered to the model) and `callable` (reachable by other tools). |
| D10 — "Tool calling with schema validation" | The ADR never specified the `Tool` shape. teenycode's five-field version (`name`, `description`, `schema`, `execute`) carries a working agent; upstream's adds `label`, `executionMode`, `prepareArguments`, `outputSchema`, `replay`. |
| D10 — "Compaction, simplified" | Upstream's compaction entry carries the **system message and tool checkpoint** at the boundary; without it a compaction silently drops the tool declarations and the model calls tools that were withdrawn. |
| Consequences — "under 30 KB gzipped for the core plus adapters" | A byte budget is gamed by minification. State the budget as a **file count per entry point**, which tracks how much code the browser must evaluate. |
| Alternatives — "Use `@mariozechner/pi-ai` as the provider layer — eleven dependencies" | `pi-ai`'s **root barrel pulls in no provider SDKs**; they sit behind subpath exports and lazy dynamic imports. Depending on it is therefore cheap for a browser bundle, and the objection is supply-chain weight, not dependency count. |

## What survived unchanged

D1 (TypeScript, browser-first), D2's single-package-with-layers shape, D3's
pure-function-core-returns-a-stream, **D4 (everything privileged belongs to the host)**,
D8's principle that browser safety is enforced by tooling rather than convention, and
D9's event union — which turns out to be *identical* to upstream's, in 24 lines rather
than 885.

The recurring finding across all of it: this ADR's fear of being heavy was misdirected.
It was not heavy where the reference projects are heavy — no MCP client, no storage, no
UI framework, no decorators. It was heavy in exactly one place: it tried to ship a
portfolio of periphery at once. Every one of those pieces could be cut and the core
would still work, which is precisely what D4 says.
