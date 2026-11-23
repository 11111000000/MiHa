# MiHa

**A minimal agent harness for the frontend, with a symmetric peer on the backend.**

MiHa is a small library an application embeds so it can run an agent loop, call tools,
and stream results into its own interface. Genium and Geopulse are the target kind of
application: rich domain products (genealogy, travel) with a real agent embedded.

MiHa is frontend-first. It is built knowing that a backend agent exists and that the two
must be able to hand work to each other:

- The frontend agent delegates to the backend agent what belongs on a server — heavy
  computation, data the browser does not hold, long jobs, credentials the browser must
  not see.
- The backend agent delegates back what needs browser context — reading the rendered
  interface, driving the UI, using local storage.
- The same MiHa code runs in both places, and the task exchange is symmetric.

In the browser MiHa normally runs in a **Web Worker**, so a slow turn never freezes the
interface. The main thread is the host for everything privileged: DOM, storage, browser
APIs.

## Why our own core, and not pi's

Measured, for the browser target, minified and gzipped:

| | gzip | Of the 30 KB ceiling |
|---|---|---|
| `@earendil-works/pi-agent-core` | **22 638 B** | 76 % |
| MiHa's core | **5 103 B** | 17 % |
| MiHa's core + the provider layer | **6 523 B** | 22 % |

Pi's core does not fit the ceiling: the layers MiHa still needs on top of it — the
worker host, the peer exchange, the trace, the interface — would take it to about
31 KB. And pi has no way for a backend agent to hand a task to a frontend agent and
call back into the browser's tools, which is the core of this project's concept.

The full comparison, with what it costs us, is in
[docs/research/04-build-vs-use.md](docs/research/04-build-vs-use.md).

## The architecture, in one document

**[docs/architecture.md](docs/architecture.md)** — the final architecture: the five
parts, a run end to end, the laws, the five budgets, and what is deliberately absent.

[docs/target-architecture.md](docs/target-architecture.md) — the derivation by four
qualities of the harness itself: **effective · reliable · small · frugal**.

## Where things are

| Path | What |
|---|---|
| `docs/plan.md` | **the route through the work**: what is built, in what order, how each piece is proved |
| `docs/architecture.md` | **the final architecture**: how everything works |
| `docs/target-architecture.md` | the derivation: four qualities, five budgets, one memory law |
| `docs/method.md` | **how this repository is developed**: the claim → code → proof → commit loop and the gate |
| `docs/adr/0005-core-harness.md` | the core harness: the state machine, the tool contract, dispatch, the peer exchange |
| `docs/adr/0006-alternatives.md` | the alternatives, and what we take from them |
| `docs/adr/0007-peer-boundary.md` | a peer may be given a task, never a handle on our tools |
| `docs/adr/0008-final-architecture.md` | the decision that fixed the final architecture |
| `docs/adr/0009-policy-defaults.md` | the three policy defaults: result 8 192 B, turns 32, window 64 |
| `docs/adr/0010-context-policy.md` | the context policy: 128 KiB, and what does not fit is collapsed |
| `docs/adr/0011-receiving-side.md` | the receiving side of the exchange: it runs the peer's task with its own tools |
| `docs/adr/0012-cassette.md` | the cassette: the provider's responses under the hash of the request |
| `docs/adr/0004-quality-bar.md` | the quality bar and the budgets it is measured against |
| `docs/adr/0003-core-scope.md` | how much of pi to take, and what "parity" means |
| `docs/adr/0002-core-harness.md` | the architecture |
| `docs/adr/0001-core-architecture.md` | superseded; kept as the decision trail, with its own critique |
| `docs/research/01-reference-landscape.md` | the reference harnesses, read and measured |
| `docs/research/02-scenario-runtime-landscape.md` | browser isolation, WASM, runtime interface generation, stochastic evaluation |
| `docs/research/03-pi-core-teardown.md` | pi's core taken apart, and the reachability of parity |
| `docs/research/04-build-vs-use.md` | our core against pi's: the measured comparison, the pros and the cons |
| `docs/research/05-alternative-architectures.md` | the alternative architectures, and what the evidence says about ours |

## Status

Research and architecture are done; the first implementation slice is in place.

Decided: TypeScript, browser-first; **our own core**, written for the job, with
upstream pi's browser-safe test suite as the conformance specification rather than as a
dependency or a fork; one package, zero runtime dependencies; the browser bundle must
fit **30 KB gzip**; in the browser the core runs in a Worker with the main thread as
host for DOM and storage; the frontend and backend agents exchange tasks over one
symmetric protocol that carries peer-initiated tool calls.

In place now: the message and event algebras, the event stream with its five laws, our
own tool-parameter schema dialect, the tool contract and dispatch plan, the append-only
transcript, the six-state machine, the driver and the provider layer — an agent runs end
to end against a scripted or OpenAI-compatible provider, plus the capability bridge
and the host that lets a worker ask the application for the DOM and the storage, plus
the delegating side of the peer exchange: 107 tests, 5 096 B gzip for the core and
6 516 B with the provider layer, against a 30 000 B ceiling. Zero runtime dependencies.

Every claim has been through a **discriminator** — an agent whose job is to break the
work rather than confirm it. The first pass found four defects that every proven
control had missed: a closed set that leaked `Object.prototype`, a cancelled run that
answered one call twice, a provider failure that dropped the streamed call, and an
external abort signal that did nothing at all. The protocol is in
[docs/discriminator.md](docs/discriminator.md).

The core is designed as a **pure transition function**: it performs no I/O and emits
intents, the driver performs them, and the laws are properties of that function. The run
is a six-state machine, the transcript is append-only with a derived context, and the
tool dispatch policy is ours rather than inherited.

Four decisions of the design pass are settled in ADR 0006: the transcript is the durable
record; the provider request is a plain message list the adapter lowers; the core never
reads a clock; the turn limit is a policy with its own value for a delegated task.
The third one had a consequence worth stating — the core cannot stamp time on its own
messages, so messages carry no timestamp and the transcript is appended by intent, with
the host doing the writing.

Open, and recorded in the ADRs: whether the dialect ships as its own package; the
coercion default; whether the reference implementation ships a TUI; the backend harness
option; the exchange frames in detail.

Decided: TypeScript, browser-first; one package with enforced internal layers; the agent
core is a pinned, trimmed port of upstream `pi-agent-core` (2 548 LOC, browser-safe as
published); one provider seam, host-supplied; tools are a plain array with a permission
hook rather than a policy engine; in the browser, a Worker with the main thread as host;
symmetric task exchange with a backend peer.

Open, and recorded in ADR 0002: whether MiHa ships a ready-made worker host or only the
capability bridge; the exchange transport; credential scope on delegated work; naming.

## Working method

Development follows **math-coding**: a claim with an explicit falsifier, a machine that
checks it, and a control that proves the check can fail. The method is not next to the
work — it *is* the work:

- `bun run check` is the gate: the budget, the documents, the types, the tests and the
  evidence. It is what the commit hook runs and what CI runs.
- A slice starts by declaring its claims (`mathc add`), before the code.
- `mathc next` says what to do next and why.

How the loop works, what is claimed and what is only gated, and what the method costs
here — in [docs/method.md](docs/method.md). The evidence trail lives in `.math/v5/`.
