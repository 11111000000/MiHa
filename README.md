# MiHa

**A runtime for programs that are written by an agent.**

MiHa executes *scenarios* — TypeScript programs authored by a coding agent such as
opencode — inside a frontend application. A scenario drives an inner agent, uses
ready-made interfaces, asks the agent to generate an interface when the situation is
unclear, and delegates to another agent or a classic API when it is still unclear.

The programs are stochastic, so MiHa ships an **evaluation plane** next to the runtime:
scenarios are executed repeatedly against a corpus, and acceptance is a stability
verdict (PASS / FLAKY / FAIL) with a confidence bound, not a single green run.

The loop this enables: a coding agent writes a scenario, MiHa runs it N times, the
harness reports where it is unstable and why, the agent reads the traces and fixes it.

## Where things are

| Path | What |
|---|---|
| `docs/adr/` | architectural decisions, with the reasoning trail |
| `docs/research/` | what was read and measured, with citations |
| `docs/adr/0002-scenario-runtime.md` | **the current decision** |

## Status

Stage one: research and architecture. No implementation yet — the code was deliberately
not written against the previous concept.

Decided: TypeScript, browser-first; the core runs in the browser with an optional
backend delegate; scenarios execute in a Web Worker so the interface never freezes.

Open, and recorded in ADR 0002: tier policy (plain JS vs QuickJS-in-WASM), corpus
ownership, merge gates, and how the inner agent gets credentials.

## Working method

Development follows **math-coding**: claims with explicit falsifiers, machine verifiers
with negative controls, and an honest map of what is actually proven. The evidence trail
lives in `.math/v5/`.
