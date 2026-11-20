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

## Where things are

| Path | What |
|---|---|
| `docs/plan.md` | **the route through the work**: what is built, in what order, how each piece is proved |
| `docs/method.md` | **how this repository is developed**: the claim → code → proof → commit loop and the gate |
| `docs/adr/0005-core-harness.md` | the core harness: the state machine, the tool contract, dispatch, the peer exchange |
| `docs/adr/0004-quality-bar.md` | the quality bar and the budgets it is measured against |
| `docs/adr/0003-core-scope.md` | how much of pi to take, and what "parity" means |
| `docs/adr/0002-core-harness.md` | the architecture |
| `docs/adr/0001-core-architecture.md` | superseded; kept as the decision trail, with its own critique |
| `docs/research/01-reference-landscape.md` | the reference harnesses, read and measured |
| `docs/research/02-scenario-runtime-landscape.md` | browser isolation, WASM, runtime interface generation, stochastic evaluation |
| `docs/research/03-pi-core-teardown.md` | pi's core taken apart, and the reachability of parity |

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
transcript, the six-state machine and the driver — an agent now runs end to end against
a scripted provider: 50 tests, 4 759 B gzip against a 30 000 B ceiling, zero runtime
dependencies.

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
