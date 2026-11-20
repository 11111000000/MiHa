# Reference Harness Landscape

Collected 2026-11-20. Method: reading local clones plus GitHub API/README for network
projects. Nothing was executed or built — every number is `wc -l` or a file count over
source trees.

## What is available locally

| Project | Path | State |
|---|---|---|
| opencode (fork) | `/home/az/Code/opencode` | `sst/opencode`, v1.18.26, on a branch carrying the V2 architecture (`packages/core`, `packages/server`, `packages/protocol`, `packages/client`) |
| openai/codex | `/home/az/Code/codex` | Rust, `codex-rs/`, server-side |
| pi (earendil-works) | `/home/az/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent` | `dist/` + `docs/` only — no sources |
| omp (oh-my-pi) | `/home/az/.npm-global/lib/node_modules/@oh-my-pi/pi-coding-agent` | pi fork, full TypeScript `src/` (1337 `.ts`, ~288k LOC) |
| pi-agent-core, pi-ai (omp) | `.../@oh-my-pi/pi-coding-agent/node_modules/@oh-my-pi/` | minimal core sources |
| paseo | `/home/az/Code/paseo` | orchestrator |

Upstream pi moved: `badlogic/pi-mono` → `earendil-works/pi`. The packages that matter are
`@earendil-works/pi-agent-core` ("Agent runtime with tool calling and state management")
and `@earendil-works/pi-ai` ("Unified multi-provider LLM API").

## opencode: two architectures in one repository

V1 (`packages/opencode`, 81k LOC) is a monolith: a `while(true)` loop in
`session/prompt.ts:1081` (1631 LOC god-object) on top of the Vercel AI SDK.

V2 (`packages/core`, 33k LOC) is event-sourced: an append-only event log projected into
projected messages. The package split is enforced, not documented:

```
schema (3387 LOC, 0 node imports) → protocol (1582 LOC, 0) → server → client
                                                    ↘ core (32961 LOC)
```

The dependency boundary is a test, not a comment:
`packages/client/test/import-boundaries.test.ts:14-30` bundles the client with
`Bun.build --target=browser` and asserts that neither `core` nor `server` ends up in the
bundle. That test is the template worth copying.

What moves into a browser unchanged: `schema` (0 node imports), `protocol` (0), `client`
(bundler-proven), `llm` (9533 LOC, single `node:buffer` at `protocols/shared.ts:1`),
`session/runner/*` (1295 LOC), `tool/tool.ts` + `tool/registry.ts` (309 LOC),
`system-context/` (419 LOC), `permission.ts` (310 LOC),
`session/message-updater.ts` (397 LOC). Roughly 21.7k LOC of browser-safe, functionally
load-bearing code in total.

What needs surgery: SQLite (`bun:sqlite`/`node:sqlite`), `global.ts` with a top-level
`await` that creates directories, `Location` as a filesystem concept, `path` in ~30 files.

One more data point: `packages/app` is a 152k LOC Solid client that runs in the browser
and talks to the server over HTTP+SSE with reconnect and coalescing
(`app/src/context/server-sdk.tsx:220-242`). The browser side of the pattern already exists.

## pi: a functional core

`pi-agent-core` (omp fork) is 28 `.ts` files, 15 965 LOC. `agent-loop.ts` 3010,
`agent.ts` 1779, `types.ts` 885, `compaction/compaction.ts` 1861, `telemetry.ts` 2113,
`proxy.ts` 391.

The core is a pure function:

```ts
agentLoop(prompts, context, config, signal?, streamFn?): EventStream<AgentEvent, AgentMessage[]>
```

`EventStream` (`pi-ai/src/utils/event-stream.ts:10-219`) is a queue with async iteration,
`push`/`end`/`fail`, and `result()`. Zero dependencies, browser-safe.

The host owns everything: the tool set (`AgentContext.tools`), the system prompt
(`AgentContext.systemPrompt`), API key policy (`config.getApiKey`), permissions
(`beforeToolCall`), persistence (the core defines only entry types plus a
`ReadonlySessionManager` interface), rendering (`renderCall`/`renderResult` return
`unknown`).

`pi-ai` is 291 files, 106 935 LOC. The provider-free subset is ~11.8k LOC.

Worth noting: upstream `@mariozechner/pi-agent-core` depends on exactly two packages —
`typebox` and `@mariozechner/pi-ai`. The omp fork grew to seven dependencies, including a
native addon (`pi-natives`) and `bun:sqlite` reachable through the `pi-utils` barrel.

## omp: what not to take

The fork adds in-band tool-call dialects (26 files, 6012 LOC), telemetry (2113 LOC),
provider-native compaction v2 (849 LOC), "shake" (474 LOC), `snapcompact`, pause, IRC
interrupts, intent tracing. All of it serves dozens of providers and dozens of output
formats. For a browser micro-harness it is dead weight.

## What already exists in the frontend niche

Source: GitHub API, retrieved 2026-11-20; repository sizes are the API's `size` field.

| Project | Stars | What it is | Why it is not MiHa |
|---|---|---|---|
| `vercel/ai` | 28 093 | AI SDK, `useChat` in the browser | `streamText` lives server-side; the dependency tree is enormous (478 MB repo) |
| `assistant-ui` | 13 341 | React chat library | UI, not an agent core |
| `CopilotKit` | 38 824 | "Frontend stack for agents", AG-UI protocol | Server-centric |
| `mastra-ai/mastra` | 29 667 | TS agent framework | Server-centric and heavy |
| `openai/openai-agents-js` | 4 030 | Lightweight agent framework | Node-centric, no browser boundary |
| `plivo-labs/glance` | 62 | Agent artifact hosting + comments | Not a harness |
| `NotASithLord/peerd` | 425 | "The first AI agent harness native to the browser" (Chrome extension) | Closest analogue by niche, but a product: `agent-loop.js` 68.8 KB plus actor/spawn/egress/transfer, not a library |

Conclusion: **no reusable minimal browser agent core with full feature parity exists.**
`peerd` proves the niche is real; `@mariozechner/pi-web-ui` proves a pi agent can run in
a browser. The gap is exactly a reusable micro-core.

## What to take, what to drop

From opencode V2: the layering and **enforced** import boundaries; the event schema as
the public contract; the tool registry with `materialize(permissions)` and stale-call
detection; the `allow/ask/deny` permission rules with a reject cascade; the rule that a
declined permission halts the loop instead of becoming tool output; output bounding that
keeps head and tail.

From pi: the core shape (pure function → `EventStream`); "everything privileged belongs
to the host"; the tool contract; the toolCall/toolResult pairing invariant; the
steering/follow-up queues; `proxy.ts` (391 LOC, `fetch` + SSE, strips `partial`
server-side — about 50% less traffic); append-only context prefix to keep the provider
prompt cache warm.

Drop: Effect and Drizzle, SQLite, PTY, git, LSP, MCP-over-stdio, npm/arborist, the V1
AI SDK with its 19 packages, telemetry, dialects, provider-native compaction.

## Size estimate

A browser-first core built from scratch: **1 900–2 600 LOC** (derived from the
pi-agent-core breakdown: types 220 + event-stream 175 + schema 120 + providers 180 +
tools 130 + loop 420 + agent 200 + compaction 250 + session 180 + barrel 30).

That is an order of magnitude below opencode V2's 33k LOC core and pi's 15 965 LOC
core. Parity is not claimed by line count, though. It is claimed against a feature list,
and MiHa meets much of that list not by writing more code but by letting the host
application supply the parts that are privileged by nature.
