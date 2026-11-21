# Alternative architectures, and what the evidence says about ours

Date: 2026-11-20. Two research passes: one over the **formal models** of agent
architectures, one over the **measured** landscape. Every number below carries its
source; where a number is an estimate, it says so.

## 1. The "DeepSeek harness" premise holds — with a correction

`github.com/deepseek-ai/deepseek-harness` exists: MIT, TypeScript, created 2026-08-13,
and its own tagline is *"Everything is a Plugin"*. Its landing page says it is built on
Cordis's "everything is a plugin" architecture.

The mathematics, however, is one layer down, and it is **not about the agent loop**:

- **arXiv:2608.25512**, *A Programming Paradigm for Spatiotemporal Composability*
  (Shi, Zhang, Cui — the last two at DeepSeek-AI), 92 pages. It formalises **revertible
  effects** (every context transformation carries an inverse the runtime holds) and
  **reactive coeffects** (every context change is classified against a component's
  specification), unified into a single context type, with theorems for recovery
  exactness, ordering, progress and confluence. It models **component composition** —
  a plugin runtime — not an agent loop.
- The DeepSeek harness's own loop is imperative and carries **no algebra**: a
  `ReactLoopAgent.step()` bracketed by `turn/start` and `step/end` events.
- Its **session layer** is where the formal content that touches agents lives: a durable
  event log with **projection definitions** (`init`, a synchronous `apply(state, event)`,
  an optional wire view, a state version) and two stated **replay laws**: *"an
  update-only tail stays pending; prepending its start produces the same result as a
  complete replace"* and *"initial history followed by live append produces the same
  result as replaying the combined window"*. Plus a **reference-identity rule**: a fold
  must return the *same state object* for events it does not care about.

One premise did not survive: the paper *"Elixir: Fast, Reliable, and Simple Agentic
Programming"* **could not be found** — no such title in arXiv, Crossref or GitHub. The
closest real things with that shape are LangGraph's graph of nodes, *Pel*
(arXiv:2505.13453), and the Cordis paper. We are not asserting the citation was
fabricated; only that it does not resolve.

## 2. What the evidence says about the costs

### 2a. Schemas are constant; results compound

Source: measured by us on MiHa's own `toJsonSchema` output (942 chars, ≈235–270 tokens
per tool, exactly linear), against the MCP client best-practice threshold of tool
definitions under 1–5 % of the context window
(<https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices>)
and the measured cost of unbounded tool **results** (≈3 350·N² cumulative tokens, versus
a *linear* 21–57 K per turn for schema filtering) — arXiv:2609.22114.

Our own measurement, twelve turns, an ordinary 4 KB result per turn:

| turn | context tokens | schema share |
|---|---|---|
| 1 | 3 826 | 73.9 % |
| 6 | 8 826 | 32.0 % |
| 12 | 14 826 | 19.1 % |

**Cumulative tokens sent: 111 912.** The context grows **3.9×** in twelve turns while the
schema share *falls* — the schemas amortise, the results compound. **MiHa has no law
bounding a tool result.** That is the highest-leverage gap the evidence exposes, and it
is ours, not upstream's.

### 2b. Progressive disclosure: the hypothesis did not survive its own preregistered test

Source: arXiv:2607.04576 — 709 pages of knowledge base, four structures, three
conditions, **960 runs**. Quality A0 **6.30** vs A3 **6.32** (non-inferior). Cost fell
by **21–58 %** in the enforced and free conditions. But the authors' own finding is
sharper than the cost win: *"A capable agent never loaded the large index at all… The
saving we set out to measure did not exist for such an agent."*

And the constraint that decides it for us: **"Most providers cache the prompt prefix,
including the `tools` array. Adding or removing tool definitions mid-conversation
invalidates that cache, and the resulting miss can cost more tokens than the definitions
you removed"** (MCP client best practices, the same page).

A constant registry is therefore not a simplification — it is what keeps the prefix
cacheable. Adaptive selection costs 7× fewer tools at equal coverage on a 370-tool
registry (arXiv:2605.24660), and we have a dozen tools.

### 2c. Richer tool descriptions make the agent take longer

Source: arXiv:2602.14878, measured on 856 real tools from 103 servers. Fully augmented
descriptions: success **+5.85 pp**, partial completion **+15.12 %** — but **Average
Steps +67.46 %**, and **regressions in 16.67 %** of cases. Baseline steps per task:
5.24 (GPT-4.1), 7.78 (Qwen3-Coder-480B), 9.46 (Qwen3-Next-80B).

So a *more informative* registry makes the model iterate more. The opposite of what
intuition suggests, and it argues for small, sharp tool descriptions.

### 2d. How many turns a real task takes

Source: arXiv:2509.24002 (MCPMark, 127 tasks, 5 servers): **16.2 turns** and **17.4
tool calls** per task; prior MCP benchmarks 3.2–6.8 turns. And `pass^4 ≪ pass^1` —
failures are systematic, not noise.

### 2e. What production browser agents do

Source: read from the source trees, at the pinned revisions, without running anything.

| System | The loop | The state | Size |
|---|---|---|---|
| **MiHa** | pure `step(state, input) → {state, outputs}`; the driver performs intents; six phases | `RunState`; the transcript is durable | core **5 103 B** gzip; **1 999** code lines; 0 deps, 0 `any` |
| teenycode | `while(true)` × `while(true)` | a `messages[]` | 327 LOC |
| nanobrowser | a 1 121-LOC `loop.ts`, a 567-LOC `compaction.ts` | IndexedDB + a branch projection | 47 501 LOC; the AI SDK inside a Chrome extension |
| browser-use 1.0 | Pydantic AI + a persistent Python REPL; the model's only tool is `python(code)` | a `Session` dataclass | 16 768 LOC |
| playwright-mcp | an MCP server | the Playwright process | 72 tools |
| Stagehand v4 | three verbs: `act` / `observe` / `extract` | the browser session | versioned JSON-RPC |
| Vercel AI SDK | `ToolLoopAgent` (361 LOC), `isStepCount(20)` | server-side; `useChat` keeps the client list | `agent/` 8 873 LOC |
| LangChain `createAgent` | a LangGraph graph; middleware rewrites the request in flight | `AgentState` + a checkpointer | — |
| AG-UI | ~35 event types in 8 categories | agent-owned; `StateSnapshot`/`StateDelta` | — |
| A2A | a `Task` with a `TaskState` enum | the server owns the task | the word "tool" appears 9× in the spec |

Three of them bound the tool result — nanobrowser `RESULT_CAP = 8_000` characters,
browser-use `MAX_OUTPUT_CHARS`, LangChain a summarisation middleware. **MiHa does not.**

## 3. The alternatives, and what each would change in our 1 000 lines

### A. Durable event log with fold projections

*Shape* (DeepSeek's session layer, OpenCode V2, ESAA arXiv:2602.23193): the log is the
state; the model context is a **named projection** with its own fold
`apply(state, event) → state`.

*Change*: `TranscriptEntry` becomes a typed event union with an envelope `{seq, version}`;
`modelMessages` becomes a registered projection.

*Buys*: (i) compaction becomes a change to one fold rather than a change to the log, and
the log keeps the evidence; (ii) a **replay law becomes statable** — *fold(replay(log)) ≡
fold(log)*; (iii) **the peer exchange stops being a second vocabulary** — the exchange can
carry the same events as the transcript, so "the frontend handed the backend a task"
becomes a fact *in the log* rather than a fact in a frame.

*Costs*: an event taxonomy, a projection registry, a sequence counter, versioning
discipline. ≈150–250 lines, ≈+1 KB gzip, 0 dependencies.

*Verdict*: **the one structural change worth considering seriously.** It subsumes the
compaction design we have not written yet, and it unifies the two vocabularies we
currently have.

### B. Channels with declared merges

*Shape* (LangGraph's reducers): every mutable field names its merge function; a step
returns partial updates.

*Change*: split `RunState` into channels — `entries` (append), `calls` (append), `results`
(upsert by `toolCallId`), `queued` (append), `turn`/`nextId` (max) — and make `step`
return partial updates.

*Buys*: our law **T4** ("results are recorded in assistant order") stops being a
property of control flow and becomes a property of the `results` merge. Its negative
control becomes trivial: permute a batch, assert the merged state is identical.

*Costs*: `phase` is **not** a mergeable channel — `dispatching` after `streaming` is
wrong, so last-writer-wins is unsound there. The data channels fit; the control channel
does not. ≈80–120 lines.

*Verdict*: adopt as a **discipline** — every mutable field names its merge — even if we do
not restructure the whole state.

### C. The Cordis witness

*Shape* (arXiv:2608.25512, Def 8): an inverse does not revert an effect everywhere; it
reverts it **at the state where it was applied**, and the runtime checks that.

*Change*: state the laws in the honest form. M1 today is written as an absolute property
of the transition function, but it is really a property of the transition function **plus
the driver running the plan**. The witness is the plan's grouping: *"every call of the
batch appears exactly once, in `groups` or in `rejections`"*.

*Costs*: nothing at runtime; the work is in finding inverses for capability
registrations, and not every effect has one — a `fetch` does not, a DOM mutation only if
the prior value was recorded.

*Verdict*: adopt the **wording**, and "registrations are revertible" rather than "all
effects are".

### D. A `prepareRequest` seam

*Shape* (browser-use's capabilities, LangChain's middleware): hooks that rewrite the
request **in flight**.

*Change*: our core fixes the `ProviderRequest`, and the host's only influence is the
opaque `options` bag. A `prepareRequest?: (request) => request` on the host, called by
the driver between "the core emits `provider_request`" and "the host performs it", costs
about ten lines.

*Buys*: result elision, a per-turn model switch, a deadline, forcing compaction on
overflow, one retry of a transient provider error — all without touching the state
machine.

*Costs*: ≈10 lines.

*Verdict*: **adopt now.** It is the cheapest thing on this list and it unblocks the
most.

### E. Programmatic tool calling — code mode

*Shape* (browser-use's `python(code)`, MCP code mode): the model emits a **program**, not
tool calls; the host compiles the schemas into typed stubs in a sandbox; only the
program's output returns to the model.

*Measured*: a chained task costs 100 K+ tokens through direct calling, versus a
~200-token script and a ~15-token summary.

*Why it is wrong for us*: the sandbox is a dependency (Deno, `isolated-vm`, Monty,
pctx, Wasmtime — none is zero bytes), and our tools are **page-local DOM actions**. A
code tool over them turns a declared tool list into arbitrary script in the user's page —
precisely what the permission seam exists to prevent.

*Verdict*: **reject for now**, with the reason written down.

### F. Fixed verbs instead of a loop

*Shape* (Stagehand's `act`/`observe`/`extract`, Anthropic's workflows): remove the loop;
expose a few operations and let the **caller** decide how many to run.

*Measured* (Anthropic, *Building Effective Agents*): workflows offer predictability for
well-defined tasks, agents cost more and compound errors; on SWE-bench they *"spent more
time optimizing our tools than the overall prompt"*.

*Change*: the host decides the turn count; `turnLimit` becomes a contract rather than a
policy; the "the model decided to stop" branch disappears.

*Costs*: a smaller core, but it gives up the property the harness is named for.

*Verdict*: not a replacement — **the right default for embedded use**. Anthropic's own
rule is to add autonomy only where the step count is unpredictable, so the turn loop
should be optional. That is a configuration, not a redesign.

### G. Progressive disclosure

*Measured*: worth real money at 150–370 tools; the preregistered test found the hypothesis
did not survive; and mutating the tools array mid-conversation breaks the prompt cache.

*Verdict*: **defer**. Our registry is a dozen tools and it is constant.

## 4. The strongest argument the evidence supports against us

**Our peer exchange lets one agent invoke the other's tools while withholding the context
in which those tools were chosen.**

- Cognition's principles forbid exactly that: *"Share context, and share full agent
  traces, not just individual messages"*; *"Actions carry implicit decisions, and
  conflicting decisions carry bad results"* (<https://cognition.ai/blog/dont-build-multi-agents>).
- The protocols were designed the other way round. **A2A**: *"without needing access to
  each other's internal state, memory, or tools"*; opaque execution, an **Agent Card** —
  a *declaration*. **MCP**: the only server→client operation reaching back is
  `sampling/createMessage`, which asks for an *LLM generation*, not a tool call, and the
  spec says *"Applications SHOULD always have a human in the loop with the ability to deny
  sampling requests."* **AG-UI**: attribution (`subagentRunId`, `parentToolCallId`) but no
  orchestration. All three carry **declarations and attribution**, never a callable
  handle into the other side's tools. **Our `call` frame is a callable handle.**
- The cost of getting it wrong is measured: making tool descriptions *strictly more
  informative* cost **+67.46 %** steps and regressed **16.67 %** of cases. A peer acting
  on our behalf, blind to which affordances we chose to expose and how we phrased them, is
  a first-order risk of the same kind.

**Where the case is weakest**: Cognition's argument is about *parallel* decomposition, and
our peer is sequential. And the peer has capabilities we do not — the backend has no
browser — so "no access to each other's tools" is untenable in our case. No published
measurement of a symmetric exchange exists in either direction, so this case is argued
from protocol design plus the measured cost of context divergence, not from an A/B.

**The fix is small**: the `offer` frame should carry the delegator's **decisions** — at
minimum the tool names **with their descriptions**, ideally a compaction of the recent
trace. Our permission half of the boundary is already right (a peer's call goes through
the host's `beforeToolCall`); the missing half is the *context* half.

## 5. The gaps in what we have, that the evidence exposes

| Gap | Evidence | Cost to close |
|---|---|---|
| **No law bounds a tool result** | ≈3 350·N² cumulative tokens; three production browser agents all bound theirs | small — a byte budget on the result, enforced by the core |
| **The offer withholds the delegator's decisions** | Cognition's Principle 1 and 2; A2A's opaque execution | small — carry the tool descriptions in the offer |
| **No declared merge per mutable field** | LangGraph's reducer discipline | small — a comment and a discipline, or the full restructure |
| **The laws are stated as absolutes where they are witnessed** | Cordis Def 8 | small — wording |
| **The host cannot rewrite the request in flight** | browser-use's capabilities, LangChain's middleware | ≈10 lines |

## 6. What we could not verify

- The "Elixir" paper: not found anywhere; the premise does not resolve.
- The *Tool Decoration* paper (Yang et al.): **not found** in arXiv, OpenAlex, Crossref or
  the Hugging Face papers API. The closest measured work — arXiv:2602.14878, used above —
  measures the same trade-off on 856 real tools. If that paper exists under another title,
  its numbers are not in this report.
- No published measurement of the cost/accuracy curve against turn count for
  *structured extraction* — the shape our applications use most.
- No published measurement of a symmetric peer exchange, in either direction.
- Token counts here are a chars/4 approximation; no tokenizer was available offline.
- Nothing was executed. Every repository figure is a line or byte count over a read-only
  clone at a pinned revision.
