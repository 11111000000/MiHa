# ADR 0002: MiHa as a runtime for agent-written scenarios

- **Status:** Proposed
- **Date:** 2026-11-20
- **Owner:** petr p.b.kosov@yandex.ru
- **Supersedes:** [ADR 0001](./0001-core-architecture.md)
- **Research base:** [research 01](../research/01-reference-landscape.md), [research 02](../research/02-scenario-runtime-landscape.md)

## Context

### The concept, restated

MiHa is not a library for embedding an agent into a frontend application. It is a
**runtime for programs that are written by an agent**.

The development loop it enables:

1. A programmer drives a coding agent (opencode) to write **scenarios** — TypeScript
   programs — for MiHa.
2. A scenario runs inside a frontend application: it drives an inner agent, uses
   ready-made interfaces, or asks the agent to **generate an interface at runtime** when
   the situation is unclear.
3. When the situation is still unclear, the agent **delegates** to another agent or to a
   classic API.
4. The result flows back into the application UI.

The target applications are Genium and Geopulse: rich domain applications (genealogy,
travel products) with real agents already embedded, where the agent fills structured data
schemas, produces tours, and builds trees. They need more than a chat box, and not all
of their capability fits in the browser.

We are, in the phrase the owner used, **programming agents with an agent**. The programs
are stochastic, so the acceptance criterion is not "one green run" but **stability
demonstrated by repeated runs across many cases**. The whole system has to balance:
effective and fast, absolutely flexible and adaptive.

### Why the previous decision no longer applies

ADR 0001 designed a library that a host application embeds, with the agent core as the
product. Under the new concept the agent core is a *component* of something larger, and
the product is the loop between agent-authored programs, the runtime that executes them,
and the harness that proves them stable.

Three findings from research cycle 2 shape this decision directly:

- **Runtime overhead is negligible against LLM latency.** A Web Worker spawns in 8.3 ms
  (measured); a QuickJS module initialises in 15–30 ms (measured); a provider turn costs
  hundreds of milliseconds. The runtime costs single-digit percent of a turn. Therefore
  spend lines of code on correctness and on the evaluation plane, not on shaving
  milliseconds.
- **WASM does not give the speed or memory win the brief hopes for, in the place one
  would first reach for it.** QuickJS-in-WASM is 4–19× slower than V8 and carries a
  16 MiB linear-memory floor per WASM instance that never shrinks (measured). Its real
  value is *containment*. The honest WASM opportunity lies elsewhere: in host-provided
  primitives for hot work (diffing, tokenising, parsing), not in the scenario VM.
- **Reproducibility is not a provider feature.** OpenAI's `seed` is deprecated and
  explicitly not guaranteed; `prompt_cache_key` is a cache-routing key. The only real
  determinism lever is **record/replay**. So record/replay is infrastructure, not an
  optimisation.

### What the owner has already settled

- Runtime language: **TypeScript, browser-first**.
- Topology: the core lives in the browser; a backend agent is an optional delegate.
- MiHa normally runs in a **Web Worker** so the interface never freezes; it may run
  without one.
- Owner identity for the math-coding journal: `petr p.b.kosov@yandex.ru`.

## Decision

### D1. MiHa has three planes, and the product is the loop between them

| Plane | What it is | Who writes it |
|---|---|---|
| **Scenario** | TypeScript programs that orchestrate the work | the coding agent (opencode), reviewed by us |
| **Agent** | the inner LLM-driven agent a scenario can call | nobody — MiHa provides it, the host supplies the model |
| **Evaluation** | the harness that runs scenarios repeatedly and issues a stability verdict | nobody — MiHa provides it |

The loop is: coding agent writes a scenario → MiHa runs it N times against a corpus →
the harness reports PASS / FLAKY / FAIL with a confidence bound → the coding agent reads
the traces and fixes the scenario.

This is the whole product. An agent core alone (ADR 0001) was one third of it.

### D2. Scenarios are authored as TypeScript and transpiled at authoring time

The runtime **never compiles TypeScript**. Scenarios are transpiled by the outer agent's
own toolchain, in the repository, exactly like application code. The runtime loads ES
modules.

Rationale: shipping the TypeScript compiler to the browser costs ~8 MB, and the outer
agent already has a build. The moment a scenario needs to run without a repository —
generated at runtime, fetched from a server — the runtime path accepts plain JavaScript
modules, which is what the transpiled output is anyway.

A scenario may import only from the virtual `miha/*` namespace and from sibling modules
resolved through a host-controlled module loader with an explicit file allowlist. There
is no `npm` in a scenario.

### D3. Two execution tiers, one bridge API

| Tier | Substrate | Used for | Cost |
|---|---|---|---|
| **A (default)** | plain JavaScript in a dedicated Web Worker | scenarios our own agent wrote and we review | native V8 speed, no memory floor, `worker.terminate()` as a hard kill |
| **B (opt-in)** | QuickJS-in-WASM inside the Worker | scenarios that must have no ambient authority, or that come from outside | +1.0 MB wasm, +16 MiB floor, 4–19× slower, bounded CPU and stack |

Both tiers expose the identical capability bridge. The difference is only the substrate,
so the split costs one bootstrap path, not two architectures.

The Worker is a **scheduling** boundary, not a security boundary, and tier A says so
out loud. Measured on this machine, a same-origin Worker can reach the host's cookies
(`fetch` with `credentials: 'include'` returned 200), the host's IndexedDB, the host's
CacheStorage, and `importScripts`. Tier A is acceptable because the threat model is
*bugs*, not adversaries. Tier B exists for the case where that stops being true.

**Rejected:** WASM as the scenario language. Rust and AssemblyScript cost 3.6–60 s per
compile, which destroys the write-then-run-now loop, and LLM ergonomics in Rust are
poor. TypeScript is the language the coding agent already writes well.

**Where WASM does earn its place:** host-provided primitives for hot work. A WASM
diff/tokeniser/parser called across the bridge costs 0.254 ms (measured) — nothing next
to the work it performs — while running the same work inside tier B would cost 4–19×.

### D4. The capability bridge is the entire API surface

A scenario sees no ambient globals. It sees virtual modules, injected by the host:

| Module | Provides |
|---|---|
| `miha/ui` | emit and patch interface specs; request a component |
| `miha/agent` | run the inner agent; stream its events |
| `miha/delegate` | hand a task to a remote agent or a classic API |
| `miha/data` | read and write application state |
| `miha/env` | scenario parameters, case fixtures, clock, ids |
| `miha/log` | structured logging into the run trace |

Rules:

- Every call crosses as **structured data**. No `eval`, no code generation for
  marshalling — the arrow-js approach of building the value as source text and evaluating
  it (`src/host/quickjs.ts:408-427`) is replaced by structured construction.
- Every call carries the run's `AbortSignal`. Cancelling a run cancels its in-flight LLM
  requests, fetches and delegate calls.
- The module set is **closed**. Anything not in the table above is unreachable, and in
  tier B a Node built-in is unreachable because the VM has no ambient authority.
- Network egress is host-mediated with an allowlist, `credentials: 'omit'`,
  `no-referrer`, and blocked `authorization`/`cookie`/`origin` headers.

### D5. Interface synthesis: a declarative registry, a flat spec, patch streaming

The agent **selects**; it never authors markup.

- **Registry.** A first-class MiHa artifact: `{name, description, props: JSONSchema,
  slots, events}`. Entries come from the host application's own components. For Genium
  that is mechanical: the Svelte 4 `export let` block of each of the 144 components is
  already a prop schema and each `createEventDispatcher` call is already an event name,
  giving roughly 40–60 registry-able primitives. Domain-shaped props (Genium's `node`,
  `state`, `confidence`) need a thin adapter per component.
- **Spec.** The flat shape: `{root, elements: {id: {type, props?, children?, slots?,
  visible?, repeat?, on?}}, state}`. Two independent implementations of this format exist
  — vercel-labs/json-render (19 781★) and assistant-ui's `generative-frame/spec` — which
  is good evidence the format is sound.
- **Streaming.** RFC-6902 JSON Patch, one operation per line, over the run's event
  channel. Rendering is an incremental diff over a flat element map.
- **Validation is a gate.** An unknown component type is rejected and reported, never
  half-rendered. An unknown prop is dropped, the element is kept.
- **The prompt is derived from the registry**, the way json-render's `catalog.prompt()`
  does it: components, actions, the patch protocol, the expression syntax.

**The escape hatch is a tool call, not code.** When the agent needs a component the
registry lacks, it emits `miha/ui.requestComponent({name, description, props})`. The
host or the coding agent fulfils it out of band, the registry is extended, and the
scenario re-runs. Extending the registry is a code change, so it must be a build-time
act — which is precisely the "we program agents with an agent" loop, made concrete.

**Widget mode is out of scope for v1.** Model-authored HTML requires a separate origin,
CSP negotiation, and a repair loop. It is the right answer for computational interfaces
(measured: widgets beat specs by 0.26–0.56 there) and the wrong answer for everything
else (specs beat widgets by 0.33–0.93). Documented as tier 3, not built.

### D6. The inner agent is a pinned port of upstream pi-agent-core, trimmed

Upstream `@earendil-works/pi-agent-core` is **2 548 LOC across 6 files**, has two runtime
dependencies, and **contains no Node built-in at all** — it is browser-safe as
published. We do not reinvent it and we do not take it wholesale.

Port, keeping upstream's shape and names so pi-trained hosts keep working:

- the agent loop (`agent-loop.ts`, 952 LOC) and the `Agent` facade (`agent.ts`, 623 LOC)
- the `AgentEvent` union, unchanged (`types.ts:528-551`): `agent_start`, `agent_end`,
  `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`,
  `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- the tool contract as a plain array — `AgentContext.tools` is the registry; there is no
  registry object (upstream resolves with `tools.find(...)`)

Drop: telemetry (2 113 LOC in the omp fork), in-band tool dialects (6 012 LOC),
provider-native compaction, `fail()` on the event stream (upstream has none — errors are
events, and two error channels is worse than one), session management, and the
permission engine (upstream has none either).

Keep upstream's non-negotiable invariants, all of which are cheap and all of which
matter:

- **Every tool call receives exactly one tool result** — including unknown tools,
  validation failures, aborts, and provider errors.
- **A tool call from a message whose `stopReason` is `length` is never executed.** Streamed
  arguments are salvage-parsed, so a truncated call can parse *and* validate while being
  silently incomplete. It is failed with an error result asking the model to re-issue.
- **A tool that fails throws, or returns `isError: true`.** Both are supported; `isError`
  keeps `details` for the UI, which a throw discards.
- **The tool set may change mid-conversation**, and the change is announced to the model
  in a system message before the next request.
- **Parallel by default**, sequential if any tool in the batch declares it — a two-value
  enum, not a function-valued field.

### D7. Provider access: one seam, host-supplied, one optional adapter

```
StreamFn(model, request, options) → AsyncIterable<ProviderEvent>
```

with upstream's obligation stated explicitly: **the provider must not throw or reject for
request, model or runtime failures**; failures are encoded as protocol events and a final
message with `stopReason: "error" | "aborted"`. Without that clause every adapter author
invents their own error convention and the pairing invariant has no defined path.

MiHa ships the reusable pieces a provider author needs, not the adapters:

| Ship | LOC | Why |
|---|---|---|
| `ProviderEvent` union + `ProviderRequest` type | ~60 | the host invents nothing |
| SSE line splitter | ~50 | nobody should write an SSE parser twice |
| tool-call correlation tracker | ~120 | the AI SDK needed 534 LOC for this; it is provider-independent |
| partial-JSON parser | ~80 | streaming tool arguments render correctly; pi needed a dependency for it |

Plus **one** optional adapter, `miha/provider/openai-compat` (~300 LOC, fetch-only, no
SDK): OpenAI-compatible Chat Completions is the lingua franca and the app needs a working
default. No Anthropic adapter and no separate proxy adapter — a first-party relay should
speak the OpenAI-compatible dialect, which makes the relay a base-URL change rather than
a second adapter.

### D8. Delegation is a capability, and its wire format is thin

`miha/delegate` offers two calls: `toAgent({task, context})` and `toApi({url, ...})`.
Both stream events back into the run's channel, so a delegated result is
indistinguishable from a local one to the scenario.

- The remote receives a **named capability whitelist**, not the browser
  (the arrow-js host-bridge pattern: `HostBridge = Record<string, HostBridgeModule>`).
- The remote sends **deltas, not snapshots** — the same insight as pi's proxy stripping
  cumulative `partial` fields, arrived at independently.
- **Deferral:** the remote agent calling *back* into browser-owned tools is v1.1. It is
  the inversion that makes delegation genuinely two-way, and it is also where the
  protocol complexity lives. The wire format is designed so adding it does not change the
  forward path.

### D9. The evaluation plane is a component of MiHa, not a test script

| Piece | Decision |
|---|---|
| Corpus | cases = fixtures + expected end state. Reuse Genium's `golden-56` shape and the `fact-you` runner (`run-real-llm-suite.mjs`, `measure-corpus.mjs --baseline`) |
| Repetition | every case at n=5 for the fast gate; a rotating canary subset at n=50 for the release gate |
| Metric | **pass^k**, `C(c,k)/C(n,k)` (τ-bench, arXiv 2406.12045). Not pass@k. Unscored runs return `NaN`, never 0 |
| Confidence | Wilson score interval (Brown, Cai & DasGupta 2001). Rule of three: 0 successes in n runs bounds the failure rate at 3/n |
| Verdict | **PASS** (all n succeeded) / **FLAKY** (mixed) / **FAIL** (none succeeded). Only FAIL blocks |
| Assertions | promptfoo's vocabulary: `trajectory:tool-used`, `tool-args-match`, `tool-sequence`, `step-count`, `goal-success`, plus deterministic assertions and optional model-graded ones |
| Baseline | per-case metrics JSON + diff against a stored baseline, exactly as Genium's extractor already does |

Retries never happen inside the measurement loop. A retry that turns FLAKY into PASS must
still be recorded as a retry, and the report must read "23 passed, 2 flaky (1 retried),
0 failed".

### D10. Reproducibility: record/replay in front of the provider

A `ModelClient` sits between the inner agent and the provider. It records
(request-hash → response) into a cassette and can replay from it.

- Cassettes are committed golden artefacts for the corpus.
- `temperature: 0` reduces variance but never replaces replay: `seed` is deprecated and
  explicitly unguaranteed in the OpenAI SDK, and Anthropic and Gemini expose no seed at
  all.
- Snapshots apply only to *structured* output, with volatile fields (timestamps, UUIDs,
  ids) normalised first. The golden artefact for an interface is the **spec**, not pixels.
- `prompt_cache_key` is forwarded when the provider supports it — it buys cost and cache
  locality, not determinism, and `prompt_cache_diagnostics` lets the harness report it.

### D11. The inner agent proposes; deterministic code disposes

The shape Genium's `fact-you` already uses. The agent produces candidates; deterministic
code validates, orders, deduplicates and applies them. This is what makes an inner agent
usable inside a data application, and it is what keeps the *deterministic* tier of
scenarios free of model calls entirely — which is the cheapest possible scenario.

### D12. Everything privileged belongs to the host

Unchanged from ADR 0001, and re-verified against every reference studied: the model, the
credentials, the tool implementations, the storage, the component registry, the policy.

### D13. Enforcement by tooling, and the budgets are file counts, not bytes

The checks that make the above true, adapted from upstream pi's
`scripts/check-browser-smoke.mjs`, `scripts/check-entry-graphs.mjs` and
`scripts/check-runtime-deps.mjs`:

| Check | Mechanism |
|---|---|
| Browser safety | bundle each entry point for the browser target and assert, on the bundler **metafile**, which modules are present and which are absent. A regex scan is a lint, not a proof — and it has false positives (`path` as a JSON-Pointer field name) and false negatives (`import(someVariable)`) |
| Layer direction | per-entry **file-count budget** plus a `forbid` list, counting only value imports. "One stray `export *` can silently make a narrow entry drag an entire barrel" — upstream's own comment |
| Runtime dependencies | walk every source file with the TypeScript compiler API, resolving every `import`, `export`, dynamic `import()` and `require()`, and fail on anything undeclared |
| Size | a **hard** size budget that fails the build, in the style of arrow-js's `build/size.mjs` |
| Node built-ins | no *statically analysable* `node:` import. A built-in may only be reached through a variable specifier behind a runtime guard — upstream's rule (`packages/ai/src/auth/context.ts:11-12`) |

## Consequences

**Positive**

- The acceptance criterion becomes real. A scenario is not "done" when it passes once; it
  is done when its pass^k and confidence bound clear the gate.
- The coding agent gets a tight feedback loop: write scenario → run N times → read traces
  → fix. The traces are the same events the UI consumes.
- Runtime overhead is a rounding error against LLM latency, so the design can spend
  lines on the evaluation plane.
- The bridge is one API whether the substrate is V8 or QuickJS, and one API whether the
  model is local or delegated.
- The registry is derived from the host's own components, so generated interfaces look
  like the application rather than like a bolted-on widget.

**Negative**

- Scenarios cannot use npm packages. A scenario that needs a real dependency must call
  a host capability instead. This is a real constraint on what the coding agent can
  write, and it will need a documented pattern.
- Tier B is measurably slower and heavier than tier A. Scenarios must stay
  coarse-grained and I/O-shaped; hot loops belong in host primitives. This must be
  written down or scenarios will be written wrong.
- `miha/data` and the component registry are host-shaped. A MiHa scenario is not
  portable between applications without a translation layer.
- The evaluation plane is a substantial piece of work, and it is the piece most likely
  to be under-estimated. It is also the piece that makes the rest worth having.

**Neutral**

- MiHa is larger than ADR 0001's core. It is still small in absolute terms: roughly
  2 500 LOC of agent core, 1 200 of scenario runtime and bridge, 800 of UI spec layer,
  1 000 of evaluation harness. The total is a rounding error next to the LLM calls it
  orchestrates.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep ADR 0001 as written: MiHa is an embeddable agent core | Wrong product. The concept is a runtime for agent-written programs with a stability harness. The agent core survives as a component, not as the product. |
| Vendor upstream `pi-agent-core` unmodified | 2 548 LOC is affordable, but it drags `pi-ai` and `pi-schema` and a body of behaviour we do not want. Port the three files we need, pinned, with upstream's names preserved. |
| Hand-write a JSON Schema subset validator | It rejects valid schemas and will not coerce `"42"` → `42`, which models do send. Upstream's `pi-schema` is a full draft-2020-12 validator, 0 dependencies, 8.5 KB min+gzip, 2222/2223 of the official test suite. Depend on it or port it; do not reimplement a worse one. |
| QuickJS-in-WASM as the only tier | Loses on speed (4–19×) and memory (16 MiB floor, never shrinks) and does not bound the WASM footprint anyway. It buys containment, which tier A does not need for our own scenarios. Keep it as tier B. |
| Rust or AssemblyScript scenarios | 3.6–60 s per compile kills the write-then-run loop; poor LLM ergonomics; no benefit over tier A for trusted code. |
| Compile TypeScript in the browser | ~8 MB compiler in the bundle for a need the outer agent's toolchain already meets. |
| Model-authored HTML in a sandboxed frame (widget mode) | Needs a second origin, CSP negotiation and a repair loop. It wins only for computational interfaces. Tier 3. |
| A2UI as the interface wire format | More formally complete than the flat spec, with catalog negotiation and bidirectional calls, but heavier and it assumes an agent SDK we do not have. The flat spec has two independent implementations already. |
| MCP in v1 | zypher's MCP client is 1 285 LOC across two files before OAuth — half a core budget, for a feature the brief does not ask for. Out of scope. |
| One binary pass/fail gate | Google measured that ~84% of pass→fail transitions involve a flaky test. A binary gate trains everyone to ignore red. Three-state verdict instead. |
| `seed` + `temperature: 0` as the determinism story | `seed` is deprecated and explicitly unguaranteed. Record/replay is the only honest answer. |

## Out of scope for this ADR

- The component registry's schema format and the adapter for Genium's domain props.
- The delegate wire format in full.
- The corpus format and the dashboard for the evaluation report.
- The inner agent's prompt and the tool catalogue it ships with.
- MCP, session branching, provider-native compaction, sub-agents.

## Open questions for the owner

1. **Tier policy.** Do we ship tier B (QuickJS) in v1 at all, or tier A only, with tier B
   designed but not built until a scenario needs it?
2. **Corpus ownership.** Does the evaluation corpus live in MiHa or in each host
   application? MiHa's harness should be reusable, but the fixtures are domain-specific.
3. **Gate thresholds.** What pass^k and confidence bound must a scenario clear to merge?
   The research suggests pass^3 ≥ 0.9 with a Wilson lower bound ≥ 0.75 on the fast gate,
   and a stricter bound on release.
4. **Agent access.** Should the inner agent get the application's real credentials, or a
   scoped subset?
5. **Naming.** "MiHa" as the package name, and a second name for the evaluation plane?
