# Build our own, or use pi?

The question the owner asked: *maybe we should not build this at all — pi is excellent
and there is nothing to invent. On the other hand, we want one we fully control, and
reliable and effective. Analyse it, write the pros and cons, and ask what is missing.*

This document answers it with measurements, not with taste.

## The measurement that decides it

Built for the browser target, minified, gzipped.

Source: `bun build --target=browser --minify` against the published package
`@earendil-works/pi-agent-core@1.5.2` and against MiHa's `src/index.ts`, measured
on 2026-11-20. The pi figure is the published package's own graph of 82 files.

| | gzip | Of the 30 KB ceiling |
|---|---|---|
| **`@earendil-works/pi-agent-core`** (`Agent` + `agentLoop` + `runToolCall`) | **22 638 B** | **76 %** |
| MiHa's core (`src/core/` + `src/schema/`) | **5 103 B** | **17 %** |
| MiHa's core + the provider layer | **6 523 B** | **22 %** |

Pi's core does not fit. It takes three quarters of the ceiling, and the layers MiHa
still needs on top of it — the worker host, the peer exchange, the trace and the
interface layer, together roughly 2 000 lines — would add another 6–8 KB. Using pi's
core lands at about **31 KB**, over the ceiling.

That is not an argument from taste. It is the arithmetic of the constraint the owner set.

## The three options, honestly

### A. Depend on pi's core

**Pros**

- Zero code of ours in the loop, and upstream keeps fixing its bugs.
- Its test suite is 4 238 lines of executable specification, already written.
- It has behaviours we did not take: `prepareArguments`, the tolerant argument parser
  (559 LOC), the `partial`-stripping proxy, thinking levels, tool exposure levels.
- Nothing to maintain.

**Cons**

- **22.6 KB gzip** — 76 % of the ceiling, before a single line of ours.
- **It brings pi-ai's types with it.** `AgentTool extends Tool<pi-schema>`,
  `AgentLoopConfig extends SimpleStreamOptions`, `StreamFn` over pi-ai's `Model` and a
  **branded** `TranscriptContext` that only pi-ai's `normalizeContext()` can mint. Our
  host would have to speak pi's type system to give it a model.
- **It cannot be the frontend-first shape we need.** The loop's assumptions — a catalogue
  of models with cost tables, a transcript that carries the system prompt as system
  messages, `partial` snapshots on every provider event — are a terminal harness's
  assumptions. We would be building a browser harness around a CLI's data model.
- **It has no peer protocol.** The symmetric task exchange with a peer-initiated tool
  call does not exist in upstream pi. Only the `oh-my-pi` fork has it, and that fork is
  15 965 lines with `node:fs` reachable through a barrel dependency — it is not
  browser-safe.
- Its roadmap is not ours. A browser-first direction would have to be proposed upstream
  and wait.

### B. Vendor pi's core and trim it

**Pros**

- The hardest parts arrive as working, tested code: the pairing invariant, the
  truncated-call rule, the abort races, the steering semantics.
- We would keep the pieces we want and cut the rest.

**Cons**

- Upstream's code is welded to pi-ai's types, so "trimming" means **rewriting the
  types anyway** — the port becomes a transcription, and the tested original stops
  matching the code we ship.
- A vendored copy in a **public** project carries the attribution, the NOTICE and the
  governance of a fork. It is legal (MIT) and common, but it makes MiHa a derivative
  in the eyes of a reader, and it makes every divergence ours to explain.
- Upstream's fixes stop arriving unless we merge them, and merging them means merging
  our divergence back — a permanent tax.
- The measured result would still be pi's *shape*: the catalogue, the system-message
  transcript, the `partial` snapshots.

### C. Our own core

**Pros**

- **5 103 B gzip** — 17 % of the ceiling, with room for every layer MiHa still needs.
- The shape is ours and answers our brief: a provider-neutral message model, a plain
  data request the adapter lowers, a thin event vocabulary without whole-message
  snapshots, a core with no clock, no storage and no catalogue.
- The peer exchange — the thing upstream does not have — is ours by construction.
- **Zero runtime dependencies.** One upstream package would be a permanent supply-chain
  edge on every install.
- The laws are ours, stated with their derivations, and checked by machines.

**Cons**

- We own the bugs. The discriminator found **four real defects in our code in one pass**
  — the closed set leaking `Object.prototype`, a cancelled run answering one call twice,
  a provider failure dropping a streamed call, and an abort signal that did nothing.
  Pi has had eighteen months and a larger community.
- We gave up things pi has: the tolerant argument parser, `prepareArguments`, the
  `partial`-stripping proxy, thinking levels, tool exposure levels. Each is a real
  feature we do not have.
- Our core has ~19 claims with proven controls; pi's has 4 238 lines of tests we have
  not run. **Our evidence is thinner than pi's, not stronger.**
- The rewrite cost is real and was paid partly by rediscovery: sixteen behaviours that
  are not derivable from first principles.

## What the evidence actually supports

Not "ours is better than pi's". **Ours is smaller, browser-shaped, and ours.** Pi's core
is a good piece of work and it is *not* better than ours at being a browser-first
harness, because it was never one.

The honest summary:

- **On size and fit, the decision is not close.** 5 103 B against 22 638 B. Pi's core
  does not fit the ceiling the owner set. That settles it for the frontend.
- **On maturity, pi is ahead.** Our core is two weeks old and has four defects a
  discriminator found immediately. Pi's has been hammered.
- **On the peer exchange, the difference is categorical.** Upstream has no way for a
  backend agent to hand a task to a frontend agent and call back into the browser's
  tools. That is the core of this project's concept, and it exists nowhere else that we
  found — the fork has it, but the fork is not browser-safe.

So the choice is not "ours against pi's". It is **"the frontend harness we need, at a
size that fits, with the peer exchange included"** — against **"a terminal harness that
does not fit, does not have the exchange, and whose types we would have to adopt to
use at all."**

## What we take from pi anyway, and what that costs

Upstream is still our **specification**. Concretely:

- Its test suite is read as the source of the behaviours we implemented. Where we
  transcribed, the behaviour is theirs; where we wrote it differently, the ADR says so
  and why.
- Its `README` and `AGENTS.md` shaped the tool contract, the event union and the
  permission seam.

The cost of that: **we are a derivative in spirit even though we are a derivative in
name only.** A public reader may reasonably ask why the same problems were solved again.
The honest answer is in ADR 0003 D15: the shape is different because the brief is
different, and the size difference is 4.4×, not a rounding difference.

## The question that is still open

Whether MiHa is a **public package** or an **internal one** changes the governance
half of this. As a public OSS project with a name of its own, we would rather be a
clean-room implementation with pi named in the history than a fork with pi's shapes
under our name. That is a decision for the owner, and it is the one thing in this
document that the measurements cannot settle.

## What is still missing from the evidence

1. **The size of the layers MiHa has not built yet** — the interface layer, the trace,
   the compaction — is estimated, not measured. The budget has room, but the estimate
   could be wrong.
2. **A real browser.** Every measurement is on Bun and Node. The Worker placement, the
   capability bridge and the exchange have never run in a page. The `postMessage` of a
   value that cannot be cloned is untested against the real platform.
3. **A real provider.** The OpenAI-compatible adapter has only ever seen a scripted
   body. It has never talked to a provider.
4. **A real peer.** The exchange has never crossed a socket.
