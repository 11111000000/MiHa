# Research cycle 2 — execution substrate, generative UI, stochastic evaluation

Date: 2026-11-20. Companion to [01-reference-landscape.md](./01-reference-landscape.md).

> **Note on framing.** This cycle was commissioned under a mistaken reading of the
> brief — that MiHa would be a runtime for programs written by an agent, with an
> evaluation harness as a product component. It is not: "we develop agents with an
> agent" is the **development style** for the applications we build, not part of
> MiHa's runtime. The measurements below stand and are load-bearing for
> [ADR 0002](../adr/0002-core-harness.md) — in particular the Worker findings, the
> WASM findings, and the fact that a Worker is not a security boundary. The
> runtime-interface-generation and evaluation sections are retained because they still
> bound what the **host** can reasonably build on top of MiHa, and because the trace
> and record/replay mechanisms they identify are adopted as runtime features (ADR D11).

Cycle 1 asked "how do we build a small browser-embeddable agent core". Cycle 2 asks
three questions that follow from MiHa being a frontend-first agent harness with a
symmetric backend peer:

1. What substrate should agent-written code run on in the browser?
2. How can an agent generate an interface at runtime, safely and fast?
3. How do you decide that a stochastic agent-written program is stable enough?

Everything below was measured or read, not assumed. Where a number is measured it is
labelled as such; where it is inferred it says so.

## 1. Execution substrate

### 1.1 What was measured

Measurements were taken on this machine (Linux x64, Node 22.22.2, headless Chromium
149.0.7827.200, localhost). Sources: `quickjs-emscripten@0.32.0` shipped artefacts, and
`@arrow-js/sandbox` (`/tmp/opencode/research/arrow-js/packages/sandbox/src/**`).

Source: measured on this machine against `quickjs-emscripten@0.32.0` shipped artefacts
and `@arrow-js/sandbox`; raw artefacts in `/tmp/opencode/qjsbench/` and
`/tmp/opencode/browserbench/`.

| Measurement | Value | Note |
|---|---|---|
| QuickJS-WASM vs V8, scenario-like workload (allocation + strings + containers) | V8 **23.8 ms**, QuickJS-WASM **453.7 ms** (browser); V8 92.6 ms, QJS 364.9 ms (node) | Ratio 3.9×–19.1× depending on JIT warmth. **No published browser benchmark exists** — these are ours. |
| Host ↔ VM round trip | 0.254 ms in-browser | Price of every bridge call |
| Web Worker cold spawn + first ping/pong | 8.3 ms median (16.6 ms first) | localhost |
| QuickJS module init | 29.3 ms first (incl. 1.0 MB wasm fetch), 14.0 ms warm, 8.9 ms second instance in page | 19.5 ms inside a Worker |
| `quickjs-emscripten` wasm size | **1 027 523 B** (release-asyncify) / 503 134 B (release-sync) / 1 510 753 B (debug) | asyncify is needed for async host functions |
| WASM linear memory, initial | **16.0 MiB**, grows in 64 KiB pages, hard cap 2 GiB, **never shrinks** | per WASM *instance* |
| `setMemoryLimit(16 MiB)` under an allocation loop | linear memory still reached **2 147 483 648 B (2 GiB)** | the VM limit does **not** bound the WASM footprint |
| QuickJS CPU interrupt (`setInterruptHandler`) | fires in **6.2 ms** (browser), 4.2 ms (node), error `interrupted` | works |
| Sandboxed iframe (`allow-scripts`, opaque origin) startup | 28.1 ms median | 7.9 ms with `allow-same-origin` |

### 1.2 What the security probes showed

Same-origin Web Worker, real origin `http://127.0.0.1:8788`:

```
location.origin    → same as the page
indexedDB.open()   → succeeded (host origin's IndexedDB)
caches             → available
importScripts      → available
fetch(same-origin, credentials:'include') → 200   ← carries the host's cookies
document           → undefined          ← the only thing the Worker actually takes away
```

Sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`):

```
origin                    → "null"           (opaque)
parent.document / localStorage / cookie → SecurityError
own localStorage / cookie / caches / indexedDB → SecurityError
own fetch(host origin)    → TypeError: Failed to fetch  (CORS, Origin: null)
parent.postMessage        → the only channel out
```

So: **a same-origin Worker is a scheduling boundary, not a security boundary.** A QuickJS
context *is* a capability boundary — it has no `window`, no `localStorage`, no ambient
`fetch`, so it cannot reach the host's credentials even though it shares the origin.

### 1.3 What `@arrow-js/sandbox` gets right and what it must not be copied for

Right, and worth copying:

- **Capability bridge.** Six globals installed into an empty QuickJS context: a send
  channel, a bridge call, four host-owned timers, and a restricted `fetch`
  (`src/host/quickjs.ts:859-1065`). Bridge exports are synthesised as virtual ES modules
  under a reserved prefix and routed by a module loader that throws
  `Unsupported sandbox import` for anything else (`:429-471`, `:1067-1082`). The public
  surface is three lines (`src/shared/protocol.ts:12-16`).
- **The patch protocol.** The VM never touches the DOM; it emits
  `set-text | set-attribute | remove-attribute | set-event-binding | clear-event-binding |
  replace-region` (`src/shared/protocol.ts:167-199`) and the host applies them with
  trusted code.
- **Events as values, not DOM nodes.** `SandboxedEventPayload` carries a snapshot of the
  target (`src/shared/protocol.ts:46-63`); the scenario never gets a DOM node and the host
  never evaluates an expression.
- **Network policy.** `https:` only, `credentials: 'omit'`, `no-referrer`, `cors`, a
  15 s timeout, a 1 MB response cap, and blocked `authorization`/`cookie`/`host`/`origin`
  headers (`src/host/quickjs.ts:161-276`).

Must not be copied:

Source: read from `@arrow-js/sandbox/packages/sandbox/src/**`; the two measured
consequences were measured in headless Chromium 149 on this machine.

| Flaw | Where | Consequence |
|---|---|---|
| QuickJS runs on the **main thread** — no `Worker` anywhere in `packages/sandbox/**` | — | a runaway scenario froze the page for **2006 ms** with **0** event-loop ticks |
| No interrupt handler | `src/host/quickjs.ts:511-513` | infinite loops are unbounded in time |
| Host→VM marshalling by `eval` | `:408-427`, `:638-644` | a latent injection surface and a per-call `evalCode` round trip |
| A never-settling top-level `await` hangs boot silently | `:489-495` → `:1084` → `src/host/instance.ts:123` | the sandbox never mounts and never reports an error |
| One cached WASM module shared by all sandboxes | `:72`, `:473-481` | one bad scenario grows the shared linear memory for all of them |
| `setMemoryLimit` does not bound the WASM footprint | measured | 2 GiB reachable under a 16 MiB VM limit |

Its own README concedes the point: *"This is not yet a hard boundary against CPU or
memory exhaustion"* (`packages/sandbox/README.md:251`).

### 1.4 WASM as a scenario language

Source: AssemblyScript compile cost measured locally (`asc` 0.28.20); the remaining
compile costs are the ranges published by each toolchain and are marked as unmeasured
where they were not reproduced here.

| Option | Compile cost | LLM ergonomics | Verdict |
|---|---|---|---|
| TypeScript → transpiled JS | 0 | excellent | the language for scenarios |
| AssemblyScript | 3.6–4.9 s measured for a 6-line file | good but a different type system, no `any` | rejected: seconds per iteration |
| Rust + wasm-bindgen | ~10–60 s (not measured — no Rust toolchain here) | poor: borrow checker, lifetimes, error messages that fight LLM repair loops | rejected |
| TinyGo / Zig | 5–30 s | wrong language | rejected |
| `deno_core`, `nodejs-mobile`, `workerd` | — | — | no browser artefact exists; `workerd` npm package is 155 MB |

Wasmtime is not available in the browser: it needs executable memory pages, which
browsers forbid (`docs.wasmtime.dev/stability-platform-support.html`). The Bytecode
Alliance's `jco` / `componentize-js` are **build-time** tools, not runtime ones.

### 1.5 What this means for MiHa

**QuickJS-WASM loses on both axes the brief cares about.** It is 4–19× slower than V8 and
costs a 16 MiB linear-memory floor per WASM instance that never shrinks. Its win is
*containment* — bounded CPU, bounded stack, no ambient authority.

So the honest conclusion is:

- **Scenarios run as plain JavaScript in a dedicated Web Worker.** Native V8 speed, no
  16 MiB floor, `worker.terminate()` as a guaranteed hard kill, main thread untouched.
  The Worker is not a security boundary, and it does not need to be: scenarios are code
  our own agent wrote and we review.
- **QuickJS-in-Worker is the opt-in tier** for scenarios that must not have ambient
  authority (third-party or user-supplied code), or when the host needs "no ambient
  credentials" as a policy. Same bridge API, different substrate.
- **The real WASM opportunity is not the scenario VM — it is host-provided primitives.**
  Diffing, tokenisation, parsing a large payload: those are hot loops that would
  otherwise run inside a slow VM or inside the scenario at all. A WASM primitive called
  across the bridge costs 0.254 ms, which is nothing next to the work it does.

## 2. Runtime UI generation

### 2.1 The field's consensus

Almost every system sold as "generative UI" in 2026 is **constrained**: the model picks
from a registry the developer wrote and emits **JSON**, never code. `narrowin/awesome-generative-ui`
(154★) states this as the consensus. CopilotKit's own generative-UI doc
(`CopilotKit/generative-ui`, 898★) taxonomises the field as Controlled (AG-UI) vs
Declarative (A2UI / Open-JSON-UI) vs Open-ended (MCP Apps) vs Open.

The unconstrained branch exists but is always sandboxed in a **separate origin**.

### 2.2 The three named systems

| System | ★ | Mechanism | Browser-pure? |
|---|---|---|---|
| **vercel-labs/json-render** | 19 781 | Flat spec `{root, elements, state}`, streamed as RFC-6902 JSON Patch one op per line; a component+action catalog with Zod-typed props; `catalog.prompt()` generates the model prompt; `catalog.validate(spec)` gates rendering; renderers for React, Vue, **Svelte 5**, Solid, RN, PDF, Email | yes — pure client-side, Apache-2.0 |
| **a2ui-project/a2ui** | 17 658 | The formal spec: `createSurface` / `updateComponents` / `updateDataModel` / `deleteSurface`, `DynamicString` with JSON-Pointer data bindings, catalog negotiation, `callRendererFunction` | yes, but heavier and assumes an agent SDK |
| **assistant-ui** | 13 341 | Ships all three strategies: A2UI client, `generative-frame` spec mode (json-render-compatible, an independent second implementation), and widget mode (model-written HTML in a separate-origin frame) plus `repairLoop` and a delegation recipe | yes |

CopilotKit's `useComponent(name, zodSchema, component)` makes the wire format
"tool name + JSON args → props". A2UI's security model is explicit: *"disallowing
arbitrary executable code. Every capability granted to the agent is either a safe
standard capability built into the framework, or a capability explicitly granted by the
app developer."*

### 2.3 The measured comparison

assistant-ui ran 3 models × 6 tasks × 3 repetitions × 4 formats and scored screenshots
1–5 (`apps/docs/content/docs/tools/generative-ui-formats.mdx`): *"With the same
components, specs scored at or above `present` trees for every model, and all but one of
the 54 spec answers passed validation."* Specs beat widgets by 0.33–0.93 on
non-computational tasks; widgets beat specs by 0.26–0.56 on computational ones.

### 2.4 What "Genium-like libraries" means concretely

Genium's `src/ui` is 144 hand-written `.svelte` files plus 85 `.js` helpers. There is no
third-party component library — styling is a bespoke token system (`src/ui/styles.css`,
`src/ui/palettes/*.css`) with semantic custom properties and a 4px spacing scale.

One correction to the premise: Genium is on **Svelte 4.2** (`package.json` pins
`svelte: ^4.2.18`; 4 of 144 files use runes). The Svelte 4 idiom — `export let` props,
`createEventDispatcher`, `$:` — is *ideal* for a declarative registry, because every
component's `export let` block is already a machine-readable prop schema and every
dispatcher call is already a machine-readable event name. Roughly 40–60 primitives are
registry-able.

The blocker is not the components: Genium's props are mostly *domain* objects (a `node`
with `node.data`, a `state` enum, `confidence`, `relationshipLabel`) rather than generic
visual props, so the registry needs a thin adapter per component rather than a mechanical
extraction. json-render's renderer is Svelte 5, so a Svelte 4 renderer is a small
reimplementation of the same spec format.

## 3. Evaluating stochastic agent programs

### 3.1 The metric

**pass^k**, not pass@k. From τ-bench (Yao et al. 2024, arXiv 2406.12045): pass@k asks
"can this be solved at all given k tries"; pass^k asks "is this solved **every single
time**", estimated as `C(c,k)/C(n,k)`. τ-bench's headline: gpt-4o FC gets **>60% pass^1**
on retail but **pass^8 < 25%**. A scenario that passes 6/8 times is not a passing
scenario; it is a coin flip in production.

`inspect_ai` (UK AISI) implements both as reducers and documents the detail that
matters: the pass^k estimator returns **`NaN` (unscored), not 0.0**, when `total < k`.
An unscored run must never count as a failure.

### 3.2 How many runs

Deriving from `C(s,k)/C(n,k) ≥ 0.9` and the Wilson interval:

Source: derived from the pass^k estimator (arXiv 2406.12045) and the Wilson score
interval (Brown, Cai & DasGupta 2001, *Statistical Science* 16(2):101-133).

| n runs | min successes for plug-in pass^3 ≥ 0.9 | Wilson 95% lower bound on p̂ |
|---|---|---|
| 3 | 3 | 0.29 — useless |
| 10 | 10 | 0.69 |
| 20 | 19 | 0.75 |
| 30 | 30 | 0.88 |
| 50 | 50 | 0.93 |

**n = 20 for the fast gate, n = 50 for the release gate.** With n = 20 you can *detect* a
regression, not *certify* reliability. Rule of three: zero successes in n runs means the
95% upper bound on the failure rate is 3/n — "0 failures in 3 runs" says nothing.

Stratification beats brute force: every case at n=5 (fast, catches gross regressions and
exposes variance) plus a rotating canary subset at n=50.

### 3.3 Three-state verdicts

A binary gate trains everyone to ignore red. Google measured a ~1.5% flaky-run rate
across their whole corpus, ~16% of tests with some flakiness, and **~84% of observed
pass→fail transitions involve a flaky test** (John Micco, *Flaky Tests at Google and How
We Mitigate Them*, Google Testing Blog, 27 May 2016,
`https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html`).

So the criterion must be three-state:

- **PASS** — all n runs succeeded
- **FLAKY** — at least one success and at least one failure
- **FAIL** — zero successes

Only FAIL blocks a merge. FLAKY pages a human.

### 3.4 Determinism levers

- **`seed` is deprecated and not guaranteed.** The OpenAI SDK's own docstring: *"This
  feature is in Beta… Determinism is not guaranteed, and you should refer to the
  `system_fingerprint` response parameter to monitor changes in the backend."*
  Anthropic and Gemini expose no seed at all. `temperature: 0` reduces variance; it does
  not remove it.
- **`prompt_cache_key` is a routing key, not a determinism guarantee.** It buys cost and
  cache locality. OpenAI's Responses API even exposes `prompt_cache_diagnostics`
  (`CacheHit` / `CacheMiss`), which is directly useful for the "fast and cheap" goal.
- **Record/replay is the only true reproducibility lever.** A cassette keyed on a request
  hash, committed as a golden artefact, replayed by the harness.
- **Golden outputs must be a set or a scoring function, never an exact string.** Snapshot
  only *structured* output, and normalise volatile fields (timestamps, UUIDs, ids) first.

### 3.5 The assertion vocabulary we want

`promptfoo` (27 467★) is the only harness whose assertion set already covers what a
scenario's pass criterion is: `trajectory:tool-used`, `trajectory:tool-args-match`,
`trajectory:tool-sequence`, `trajectory:step-count`, `trajectory:goal-success`, plus
deterministic assertions (`equals`, `contains`, `regex`, `is-json`, `javascript`,
`levenshtein`) and model-graded ones. Its `repeat: N` knob is the repetition primitive.

### 3.6 What Genium already has — reuse, do not reinvent

Genium's `packages/extractor` (`fact-you`) already implements most of the harness:

- **golden-56** fixture set across 18 categories (`packages/extractor/tests/fixtures/golden.json`)
- `run-real-llm-suite.mjs` — the canonical suite runner, producing per-case metrics JSON
  plus a baseline diff
- `measure-corpus.mjs --baseline=…/corpus.json` — corpus measurement against a baseline
- `eval-matrix-2026-09-16.md` — pass-rate / latency / cost comparison across three model
  tiers, with an explicit note that `totalCost` was unavailable from that provider's
  response shape
- `scripts/test-real-llm.mjs`, `scripts/test-complex-narratives.mjs --save/--diff`
  — the repeated-runs-with-baseline pattern the user describes
- `fact-you` itself has **zero runtime dependencies** and a "deterministic
  postprocessing" split: the LLM proposes, deterministic code decides

That last shape is the model for MiHa's inner agent: **LLM proposes, deterministic code
disposes.**

## 4. What this changes about the earlier design

Source: research cycle 2; sizes cited from `packages/schema/README.md:1-12`.

| Earlier decision | Verdict after cycle 2 |
|---|---|
| MiHa is a library embedded in a frontend app | **Correct reading**, but ADR 0001's version of it was wrong in its specifics: the citations pointed at the wrong repository, the schema validator was hand-rolled, and it shipped three adapters and a storage implementation it should not have. |
| Browser-safety enforced by a static regex scan | **Weak.** Replace with bundler metafile assertions + per-entry file-count budgets + a runtime-dependency audit via the TS compiler API. A regex is a lint, not a proof. |
| Hand-rolled JSON Schema subset validator | **Rejected.** `@earendil-works/pi-schema` is a full draft-2020-12 validator, 0 deps, 8.5 KB min+gzip, 2222/2223 of the official test suite. A subset validator rejects valid schemas and will not coerce `"42"` → `42`. |
| Three provider adapters shipped | **Rejected.** Ship the seam, ship the reusable author primitives (SSE splitter, tool-call tracker, partial-JSON parser), ship at most one optional OpenAI-compatible adapter. |
| IndexedDB store shipped inside the core | **Rejected.** It is a host concern. Reuse Genium's existing offline queue instead. |
| `EventStream.fail()` | **Rejected.** Upstream has none; errors are events. Two error channels is worse than one. |
| Session branching, MCP, delegation all in v1 | **Rejected for MCP and session branching.** Delegation stays — it is in the brief — but as a thin capability, with remote-calls-back deferred. |
| Nothing about evaluation | **Partly right, partly retracted.** The evaluation harness is not MiHa's product — it is the development process around MiHa. But the two mechanisms that make such a harness meaningful — a structured **trace** and **record/replay** in front of the provider — are runtime features MiHa must ship, and they are absent from ADR 0001. |
| No worker placement decision | **Added.** The core runs in a Web Worker by default; the main thread is the host for DOM, storage and browser APIs. A Worker is a scheduling boundary, not a security boundary (measured). |
| No answer on WASM | **Added.** QuickJS-in-WASM is 4×–19× slower than V8 and carries a 16 MiB linear-memory floor that never shrinks, so it is not the execution tier. WASM stays a candidate for measured hot spots only. |
