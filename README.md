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
| `docs/adr/0002-core-harness.md` | **the current decision** |
| `docs/adr/0001-core-architecture.md` | superseded; kept as the decision trail, with its own critique |
| `docs/research/01-reference-landscape.md` | the reference harnesses, read and measured |
| `docs/research/02-scenario-runtime-landscape.md` | browser isolation, WASM, runtime interface generation, stochastic evaluation |

## Status

Stage one: research and architecture. No implementation yet — code written against the
earlier, misframed concept was removed rather than adapted.

Decided: TypeScript, browser-first; one package with enforced internal layers; the agent
core is a pinned, trimmed port of upstream `pi-agent-core` (2 548 LOC, browser-safe as
published); one provider seam, host-supplied; tools are a plain array with a permission
hook rather than a policy engine; in the browser, a Worker with the main thread as host;
symmetric task exchange with a backend peer.

Open, and recorded in ADR 0002: whether MiHa ships a ready-made worker host or only the
capability bridge; the exchange transport; credential scope on delegated work; naming.

## Working method

Development follows **math-coding**: claims with explicit falsifiers, machine verifiers
with negative controls, and an honest map of what is actually proven. The evidence trail
lives in `.math/v5/`.
