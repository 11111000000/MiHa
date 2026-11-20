# Research 03 — teardown of upstream pi, and what "parity" can mean

Date: 2026-11-20. Third cycle. Companion to [01](./01-reference-landscape.md) and
[02](./02-scenario-runtime-landscape.md).

This cycle answers one question: **should MiHa port upstream pi's agent core, write a
smaller purpose-built one, or keep a compact core and reach pi parity another way?**

The answer needed measurements, so that is what this document contains. Every number
below is a count over the clone at `/tmp/opencode/research/pi` (upstream
`earendil-works/pi` v1.5.2), computed by stripping comments and blank lines.

## 1. How big is pi's agent core, really

Source: read-only analysis of `/tmp/opencode/research/pi/packages/agent/`.

Source: counted by stripping `/* */`, `//` and blank lines from `packages/agent/src/`.

| File | Total LOC | Code-only | Role |
|---|---|---|---|
| `agent-loop.ts` | 952 | 775 | the turn loop and tool dispatch |
| `agent.ts` | 623 | 497 | the stateful `Agent` facade |
| `types.ts` | 551 | **165** | the type surface |
| `proxy.ts` | 397 | 320 | a client for a first-party relay — **not part of the core** |
| `stream-fn.ts` | 20 | 11 | module-global default provider function |
| `index.ts` | 5 | 5 | the barrel |
| **Total** | **2 548** | **1 773** | |

So the figure "2 548 LOC" is the whole package, and the loop plus facade — the part
MiHa would actually replace — is **1 437 code lines**. And `types.ts` is 551 lines
because it is 70 % doc comments: of its 165 code lines, **87** are the loop/tool/event
protocol, **27** are the two policy-hook interfaces, and **51** are provider-catalogue,
model-metadata, thinking-level and cost concerns.

## 2. Feature-by-feature split of the loop and the facade

Source: `packages/agent/src/agent-loop.ts` and `packages/agent/src/agent.ts`.

| Group | What it covers | LOC (with comments) | Verdict for a frontend agent |
|---|---|---|---|
| **Irreducible core** | turn loop, provider call and stream assembly, tool dispatch, validation, pairing, abort, terminal handling | ≈ 574 | **keep** |
| **Frontend-UI relevant** | steering and follow-up queues, queue modes, `finishTurn`, tool-set change announcement, streaming tool updates, state facade, abort/idle lifecycle | ≈ 300 | **keep** — a batch CLI never needs these, a browser UI does |
| **Policy or catalogue** | model and thinking-level plumbing, per-request API-key resolution, provider attribution, provider-option passthrough, message projection hooks, `beforeToolCall`/`afterToolCall`, `proxy.ts` in full, transcript replay helpers in `pi-ai` | ≈ 726 in-package + 263 in `pi-ai` | **move out** — the host owns model choice, credentials and policy |
| **Droppable** | `replay` flag, `outputSchema` merge rules, tool `usage`, `durationMs`, `identity`/`PI_ATTRIBUTION`, `sessionId`/`transport`/`thinkingBudgets`, `state.systemPrompt` getter, `agentLoopContinue` and `Agent.continue()`, `prepareArguments`, `prepareRequest`/`prepareNextTurn` | ≈ 195 | **drop** |

## 3. The type surface MiHa actually needs

Source: `packages/agent/src/types.ts`, split by concern.

| Concern | Span LOC | Code-only | Exports |
|---|---|---|---|
| Loop, tool and event protocol | 309 | 87 | `StreamFn`, `AgentTool`, `AgentToolResult`, `AgentContext`, `AgentMessage`, `AgentState`, `AgentEvent`, `ToolExecutionMode`, `QueueMode`, and the outcome types |
| Policy-hook types | 70 | 27 | `BeforeToolCallResult`, `AfterToolCallResult`, and their contexts |
| Catalogue / model metadata / thinking level / cost | 202 | 51 | `AgentLoopConfig` (which `extends SimpleStreamOptions`), `ThinkingLevel`, `PrepareRequest*` |

MiHa needs **five** protocol types and nothing else: `AgentEvent`, `AgentTool`,
`AgentToolResult`, `AgentContext`, `AgentMessage`. That is **110–170 LOC** of its own
surface against upstream's 551 — a ~75 % reduction, and it removes the type coupling
that would otherwise infect every call site (`AgentTool extends Tool<pi-schema>`,
`AgentLoopConfig extends SimpleStreamOptions`).

## 4. What `proxy.ts` is, and whether MiHa needs it

Source: `packages/agent/src/proxy.ts`.

It is a **client-side** client for a first-party relay: *"The server manages auth and
proxies requests to LLM providers"* (`proxy.ts:1-4`), *"The server strips the `partial`
field from delta events to reduce bandwidth. We reconstruct the partial message
client-side"* (`proxy.ts:73-75`).

So the **stripping is server-side** and the **reconstruction is client-side** — and the
reconstruction exists only because `pi-ai`'s event type carries a whole-message
`partial` snapshot on every single variant (`packages/ai/src/types.ts:831-856`). That
forces `processProxyEvent` (`proxy.ts:260-397`, 138 LOC) to rebuild text blocks, thinking
blocks and tool-call argument streams from scratch on every event.

MiHa, defining its own thin event type, drops that requirement: the reconstruction
shrinks to roughly 30–50 LOC, and the relay may strip anything it likes.

Three behaviours from `proxy.ts` are worth keeping as knowledge even if the code is not
copied: a clean EOF without a terminal event must surface as an **error, not a hang**
(`proxy.ts:222-233`); the final SSE frame may not be newline-terminated
(`proxy.ts:215-220`); and accumulated tool-call arguments must not be re-parsed per
delta (`proxy.ts:343-357`, a fix for a 520 KB stream that had taken minutes).

## 5. The floor, and the gap

`teenycode`'s complete working loop is **≈ 40 code LOC**
(`/tmp/opencode/research/teenycode/src/agent.ts:69-115`). It satisfies **none** of the
six invariants MiHa needs:

| Invariant | teenycode |
|---|---|
| every tool call receives exactly one result | ✗ — non-function calls are skipped silently (`agent.ts:88-90`), leaving a call with no result |
| a `length`-truncated call is never executed | ✗ — accidentally safe, because `JSON.parse` of truncated arguments throws |
| provider failure is an event, never a throw | ✗ — `create()` throws and the error escapes the agent (`agent.ts:70`) |
| parallel by default with a per-tool sequential override | ✗ — strictly sequential |
| steering and follow-up queues | ✗ |
| the tool set may change mid-conversation, announced | ✗ — the tool list is computed once (`agent.ts:21`) |

The gap between 40 LOC and a correct core is **entirely the failure paths** — which is
exactly where upstream's 1 437 code lines live.

## 6. The smallest correct core, piece by piece

Estimates are code-only LOC for a core with its own narrow types, its own provider
transport and no `pi-ai` dependency.

| Piece | Upstream reference | MiHa estimate |
|---|---|---|
| Narrow message, event and tool types | `types.ts` | 110–170 |
| Turn loop | `agent-loop.ts:172-330` | 80–105 |
| Provider call and stream assembly | `agent-loop.ts:390-479` | 45–65 |
| Tool resolve → validate → abort-first → execute → error result | `agent-loop.ts:694-920` | 130–165 |
| Parallel executor and source-ordered result emission | `agent-loop.ts:592-660` | 50–60 |
| Sequential executor | `agent-loop.ts:540-590` | 40–45 |
| Truncated-message guard | `agent-loop.ts:488-513` | 22–26 |
| Tool-set diff and announcement | `agent-loop.ts:342-384` | 40–55 |
| Steering and follow-up queues | `agent.ts:149-180` | 55–75 |
| State facade, lifecycle, abort, failure-to-event encoding | `agent.ts:194-623` | 160–230 |
| **Core total** | upstream 1 437 | **≈ 730–990** |

If the browser application owns the state and MiHa ships only the loop and the tool
executor, the floor drops to **≈ 570–760**.

## 7. What the invariants actually cost

| Invariant | Marginal LOC | Where the cost sits | Cost profile |
|---|---|---|---|
| one result per call, always | 40–55 | six distinct failure paths, each funnelled into one result shape | cheap in LOC, expensive in correctness — upstream shipped this bug and fixed it in the *Unreleased* changelog |
| a truncated call is never executed | 22–26 | the rule depends on knowing that the provider layer *salvages* truncated JSON into arguments that **pass validation** | cheap in LOC, expensive in *knowing* — the failure mode is silent data corruption |
| provider failure as an event | 25–35 | a contract, not code: every entry point must honour it | discipline, not lines — upstream's own raw `agentLoop()` leaks a rejection |
| parallel by default, sequential override | 95–115 | the *coupling rule* — if any tool in the batch is sequential, the whole batch is sequential — is a design choice, not a derivation | the most LOC, but the subtlety is the rule, not the executor |
| steering and follow-up queues | 55–75 | the poll *cadence*: upstream polls at three distinct points, and the test asserts the count is exactly three | small LOC, hard contract |
| tool-set change announced | 40–55 | the diff is against the **transcript**, not the last request; declarations are compared by JSON round-trip to normalise schema-library artefacts | small LOC, invisible subtlety |

## 8. The upstream-fixes argument, counted

Of the behaviours encoded in upstream's code and tests, **16 are not derivable from
first principles**. Eight of them fail **silently** — they produce a plausible,
test-passing, wrong implementation:

1. A truncated tool call can look valid, because the argument parser salvages incomplete
   JSON.
2. If any tool in a batch is sequential, the whole batch is sequential.
3. Two orderings coexist: `tool_execution_end` in completion order, tool-result messages
   in assistant source order.
4. Abort must be checked **first**, before tool lookup and before the permission hook,
   and again after it returns, and again inside the parallel branch.
5. "No call left without a result" — six failure paths must all produce exactly one.
6. Orphaned tool calls are repaired **outside the loop**, in the provider payload
   builder.
7. Tool declarations must be compared by *declaration*, via a JSON round-trip.
8. A provider `error`/`aborted` response drops the tool calls inside that message
   without results.

The other eight are design choices — the poll cadence, the continuation semantics, the
structured-content merge rule, and so on — that different implementers will resolve
differently.

The honest asymmetry: upstream's value is concentrated in **1 437 code lines of
edge-case-dense implementation plus 4 329 lines of executable specification**. A
from-scratch MiHa would pay the discovery cost twice.

## 9. The highest-leverage transfer is not code — it is the test suite

Source: `packages/agent/test/` — 4 238 lines of tests plus 91 lines of fixtures.

| File | LOC | What it pins |
|---|---|---|
| `agent-loop.test.ts` | 2 357 | the loop's contract in detail: the truncated-call guard, the abort races under both execution modes, the dual ordering, the sequential-batch coupling, the `terminate` family, the continuation semantics, the steering poll count |
| `agent.test.ts` | 1 229 | the facade: tool-loadout announcement and its three merge cases, settlement semantics (awaited subscribers), post-settle update suppression, queue behaviour |
| `e2e.test.ts` | 416 | the loop against a **faux provider**, not a hand-built mock stream |
| `proxy.test.ts` | 171 | the browser-relevant transport: EOF without a terminal event is an error not a hang, a final frame may lack a newline, partial arguments accumulate in linear time |
| `agent-tool-typebox.test.ts` | 65 | the type-level contract between a tool and its schema |

The whole suite is browser-safe — it imports no Node built-ins — so it can run unchanged
in a browser CI job.

## 10. Two upstream gaps MiHa must not inherit

1. **The error/aborted hard exit drops tool calls without results.** Upstream gets away
   with it because `pi-ai`'s payload builder drops errored assistant messages and
   synthesises orphan results (`packages/ai/src/api/transform-messages.ts:188-224`).
   MiHa, defining its own narrow types, has no such safety net. If the transcript is
   ever replayed — over the peer link, for instance — every call in an aborted message
   needs an explicit result.
2. **The raw `agentLoop()` has no `.catch()`** (`agent-loop.ts:56-67`). A throw from a
   context hook leaves the result promise pending forever.

## 11. The real risk is not the loop — it is argument streaming

Upstream's streamed tool arguments rest on two modules in `pi-ai`:
`streaming-json.ts` (**559 LOC**) and `json-parse.ts` (~60 LOC). They implement
incremental tolerant JSON, a linear-time argument accumulator, salvage-parsing of
truncated arguments, and prototype-pollution-safe member assignment.

They are subtle, performance-sensitive and security-sensitive, and the ADR does not
budget for them. Three options: depend on `pi-ai` for those two modules alone; vendor
them as an attributed dependency; or **simplify** — keep the raw argument text and parse
it once at `toolcall_end` (40–70 LOC), which forfeits live partial-argument rendering but
keeps strict final parsing, and makes the truncated-call rule trivially safe because
malformed arguments simply fail to parse.

## 12. Upstream's package landscape, and what "the full harness" actually is

Source: `packages/*/package.json` and READMEs in `/tmp/opencode/research/pi`.

| Package | src LOC | Runtime deps | Browser-safe | Role |
|---|---|---|---|---|
| `agent` | 2 548 | 2 | **yes** | the loop and the `Agent` facade; no sessions |
| `ai` | 29 094 | 10 | yes for the root entry | provider layer, catalogue, auth, message types |
| `schema` | 4 852 | 0 | yes | complete JSON Schema 2020-12/7 validator |
| `coding-agent` | 82 285 | 22 | **no** — 135 node-builtin hits | the terminal harness: CLI, TUI, sessions, branching, compaction, extensions, skills, MCP, packages |
| `durable` | 35 802 | 7 | yes for the root entry | the transactional harness: conversations, commits, documents, tasks, 5 storage backends, approval parking, sub-agents |
| `chord` | 66 984 | 2 | partial | an object runtime across processes; the substrate `durable` runs on |
| `codemode` | 3 051 | 1 | no for the root entry | a QuickJS sandbox; `./portable` is the browser path |
| `mcp` | 4 755 | 1 | no for the root entry | a standalone MCP client; depends on neither `agent` nor `ai` |
| `tui` | 20 269 | 3 | no | terminal UI |
| `telemetry` | 1 630 | 0 | yes | telemetry contracts |

**The two "full harness" packages are independent.** `pi-coding-agent` does not depend
on `pi-durable`, and `pi-durable` does not depend on `pi-coding-agent` — and
`pi-durable` does not even import `pi-agent-core`: it re-implements the loop itself
(`packages/durable/src/harness/generation.ts:811`).

So upstream ships **three** distinct harnesses, and "full pi parity" is not one target.
`pi-coding-agent` is terminal-shaped and Node-only. `pi-durable` is a transactional
runtime whose value proposition — crash-resume, atomic commits, five storage backends,
approval parking, sub-agent ownership — does not exist in a browser.

Worse for the parity idea: **`pi-durable` is state-first and MiHa would be event-first.**
It emits committed entries and documents; `grep` for `AgentEvent` in `packages/durable/src/`
returns **zero hits**. Bridging the two needs a projection from documents and ops to
events.

## 13. Can pi's higher layers run on a substitute core?

Source: `packages/coding-agent/src/`, import inventory of `@earendil-works/pi-agent-core`.

**40 import sites, 37 of them type-only.** The three value imports are `Agent` and
`setDefaultStreamFn` (`core/sdk.ts:2`), `runToolCall` (`core/agent-session.ts:19-34`),
and one whole-namespace import for extension code
(`core/extensions/virtual-modules.ts:1`).

But the type-only imports are the binding ones. `pi-agent-core`'s types are defined in
terms of `pi-ai`: `AgentMessage = Message | …` (`types.ts:374`), `AgentTool extends
Tool<TParameters>` (`types.ts:478`), `AgentEvent.message_update` carries pi-ai's
`AssistantMessageEvent` (`types.ts:538`), and `StreamFn` is typed over pi-ai's
`Model` and `TranscriptContext` (`types.ts:33-37`). `TranscriptContext` is a **branded**
type that only `normalizeContext()` can mint (`packages/ai/src/types.ts:801-810`).

**The real contract is `pi-ai`, not `pi-agent-core`.** A substitute core would have to
re-export pi-ai's `Model`, `Usage`, `AssistantMessage`, `Tool`, `Message` and
`TranscriptContext` — i.e. depend on `pi-ai` anyway, a package with ten runtime
dependencies including four vendor SDKs.

## 14. What is reachable instead

Source: upstream package LOC counted in `/tmp/opencode/research/pi/packages/*/src`;
buildability assessed against the MiHa core budget in research 03 §6.

| Upstream's full-harness feature | Where it lives | Buildable on a compact core? |
|---|---|---|
| session tree, branching, revert | `coding-agent/src/core/session-manager.ts` 2 036 | **Partly** — the tree is ~350 LOC; the full manager is not |
| compaction | `coding-agent/src/core/compaction/` 1 673; `durable/src/harness/compaction.ts` 519 | **Yes** — ~300 LOC |
| skills | `coding-agent/src/core/skills.ts` 505 | **Yes** — ~150 LOC |
| sub-agents | an *example extension* in `durable` | **Yes** — ~60 LOC, and MiHa's peer exchange is a better primitive |
| MCP client | `packages/mcp` 4 755 | **No in the browser** — stdio needs a process, OAuth needs a loopback server. It belongs in the backend peer |
| provider catalogue and OAuth | `packages/ai` | **No** — a browser must not hold provider credentials |
| extension / package loading | `coding-agent/src/core/extensions/` 5 172 | **No** — it is a Node module loader executing arbitrary TypeScript in-process, exactly the privileged surface MiHa moves to the host |
| storage backends | `durable/src/storage/` 6 163 | **Not in the core** — the host owns storage |

So the reachable set is roughly **940 LOC** of new MiHa-side code: session tree ~350,
compaction ~300, skills ~150, sub-agent tool ~60, scope registry ~80.

## 15. The "MiHa in front, pi behind" option

Upstream already ships an instance of this shape: `apps/p2` is a Chord browser UI in
front of a `pi-durable` harness on the server.

It is reachable, and it is not free. The friction is concrete:

- **Two agent runtimes** with two session models, two compaction behaviours, two tool
  contracts and two event vocabularies. Upstream's own two harnesses already fail to
  share one; the split doubles it.
- **Two provider configurations** and two credential stores.
- **Two wire protocols** unless the backend's UI *is* MiHa's frontend.
- **Version skew** between pi-ai's `Usage` shape and MiHa's own.
- **An impedance mismatch**: pi-durable is state-first, MiHa is event-first.

The clean version of this option: the backend runs its harness as an **independent
service that speaks MiHa's exchange protocol at its boundary**. The translation cost is
real but contained to one adapter per direction, and MiHa's core stays dependency-free.
The dirty version — pointing the frontend's `StreamFn` straight at pi-ai — quietly makes
MiHa's core a thin client for pi's type system, which is the coupling the design is
trying to avoid.

## 16. The summary the decision rests on

Source: research 03 sections 6, 8, 9, 12, 13, 14, 15; LOC counted in
`/tmp/opencode/research/pi/packages/*/src`.

| Question | Answer |
|---|---|
| How much of pi's core does a frontend agent need? | ~730–990 code LOC, of which ~300 is frontend-specific and ~195 is droppable outright |
| How much can be pasted rather than written? | ~78 LOC. Most of the rest must be transcribed or re-derived, because upstream's code is welded to pi-ai's types |
| Where does the risk actually sit? | Not in the loop — in the sixteen non-derivable behaviours, eight of which fail silently, and in the 559-line argument-streaming module |
| What neutralises that risk? | Upstream's 4 238-line browser-safe test suite, used as an executable specification |
| Is "full pi parity" one thing? | No — it is two independent harnesses with different session models, one of them Node-only and the other state-first |
| Is "parity via extension" reachable? | Not as an extension. Upstream's extension system is a Node module loader. As a **sibling package**, ~940 LOC is reachable; the Node-only parts are better taken from upstream verbatim |
| Does the frontend case need parity? | No. The frontend needs the loop, the tool contract, the event vocabulary and the peer exchange. Parity belongs to the backend harness, which can afford 82 000 LOC and can simply depend on upstream |

## 17. Protocol facts against upstream's preferences

Section 8 counted sixteen behaviours that are not derivable from first principles. That
count conflated two different things, and the distinction matters more than the count:
some of those behaviours are **facts about how LLM provider protocols behave**, and every
correct harness must have them. The rest are **upstream's choices** — perfectly
defensible, but not laws, and a harness that copies them is a clone.

| # | Behaviour | Class | Why | MiHa's answer |
|---|---|---|---|---|
| F1 | A tool call must be answered by exactly one tool result | **protocol fact** | the provider rejects the next request otherwise — upstream has to repair orphans in the payload builder (`pi-ai/src/api/transform-messages.ts:242-247`), which is proof the fact is real | law M1, enforced in **two** places: the loop and the transcript writer. Upstream enforces it in one and leaks the other |
| F2 | A call whose arguments were cut by the output-token limit is not a call | **protocol fact** | the limit truncates the stream mid-JSON; upstream's parser *salvages* the fragment into arguments that parse and validate (`pi-ai/src/utils/json-parse.ts:106-120`), which is why it fails the whole message (`agent-loop.ts:488-513`) | law M2, detected differently: MiHa keeps the raw argument text and parses it strictly **once**, so incompleteness shows up as a parse failure rather than a stop-reason heuristic. Strictly stronger than upstream's rule |
| F3 | A provider request can fail at any point | **protocol fact** | the transcript must stay consistent across a failure | law M4: a provider failure is an event, and the pairing survives it |
| F4 | Tool arguments arrive as a JSON string; streamed arguments arrive as fragments | **protocol fact** | the wire format | our dialect parses the argument string; fragments accumulate as text |
| F5 | An abort must not leave a dangling call | **protocol fact** | the same requirement as F1, under cancellation | part of law M1 |
| F6 | The context window is finite | **protocol fact** | a long session must be reducible | compaction, our own design |
| F7 | One assistant message can carry several calls with interleaved arguments | **protocol fact** | the wire format | we track calls by id and keep them in assistant order |
| T1 | If any tool in a batch is sequential, the whole batch is sequential (`agent-loop.ts:526-531`) | **preference** | a design choice, two alternatives are equally defensible | **we choose differently**: an exclusive tool runs alone, while the shared tools around it still run in parallel. "Exclusive" means "must not interleave with another exclusive tool", not "serialise the turn" |
| T2 | Steering is polled at exactly three points (`agent-loop.ts:185`, `:213-215`, `:304`) | **preference** | an implementation detail of upstream's loop shape | we state the *semantics* — a steering message is delivered at the next tool-call boundary — and implement them our way. The poll count is not a law |
| T3 | `finishTurn` continuation semantics (`agent-loop.ts:303-307`, `:319-323`) | **preference** | upstream's policy for "one more request" | we have no such hook. The turn ends when there are no tool calls and no queued messages |
| T4 | Tool declarations compared by JSON round-trip (`pi-ai/src/utils/transcript.ts:132-142`) | **preference** | an artefact of upstream's transcript model | we have no declaration model in v1 |
| T5 | `durationMs` excludes hook time (`agent-loop.ts:831-832`) | **preference** | a definition | ours measures the tool's own execution and nothing else |
| T6 | `replay`, `outputSchema` merge rules, `AgentToolResult.usage` | **preference** | upstream's details | dropped |
| T7 | The event vocabulary, and a whole-message snapshot on every provider event | **preference** | upstream's data model | ours: two separate vocabularies, deltas only from an adapter |
| T8 | The tool-loadout announcement mechanism (`agent-loop.ts:342-372`) | **preference** | upstream's transcript model | in v1 the tool set is fixed for a run. A mid-run change is a later feature, and we say why |
| T9 | The `Agent` facade's ownership of state | **preference** | upstream's shape | ours owns less; the host may own the transcript |

So the count from section 8 splits: **seven protocol facts** that any harness must
satisfy, and **nine preferences** that a new harness is free — and ought — to decide
differently.

This is the distinction that makes "our own harness" and "correct harness" compatible.
A law that MiHa states without a derivation is upstream's preference wearing our name.
