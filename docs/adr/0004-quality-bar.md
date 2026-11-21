# ADR 0004: The quality bar, and the budget it is measured against

- **Status:** Proposed
- **Date:** 2026-11-20
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0003](./0003-core-scope.md) D15, [ADR 0002](./0002-core-harness.md) D1, D13
- **Research base:** [research 03](../research/03-pi-core-teardown.md)

## Context

The owner has settled the remaining questions:

| Question | Answer |
|---|---|
| What does "embeds into any application" mean in practice? | **≤ 30 KB gzip — a hard ceiling** |
| Who runs the backend agent? | **Also MiHa.** The exchange is symmetric |
| How public is MiHa? | **Public OSS.** A fork of pi becomes a licensing and governance question |
| Horizon to the first working version? | **Months.** It can be built properly |
| Port upstream, or write our own? | **Our own** |

And the bar for the code itself: *of the highest quality, following a deep understanding
of computer science, mathematical, functional, yet effective — the kind of thing that
gets used as a reference implementation.*

"Mathematical" and "reference implementation" are adjectives. This ADR turns them into
requirements that a machine can fail.

### The measurement that decided the dependency question

Built for the browser target with `bun build --target=browser --minify`, from the
published npm packages, then gzipped:

| Bundle | gzip |
|---|---|
| `@earendil-works/pi-agent-core` (Agent + agentLoop + runToolCall, realistic use) | **22 923 B** |
| `@earendil-works/pi-schema` alone (its validator) | **12 446 B** |
| `@earendil-works/pi-ai` core (event stream + streaming JSON parser) | **4 742 B** |

pi's agent core alone is **76 % of our entire budget**. Adding a provider adapter, a
worker host, the peer exchange and tracing would exceed 30 KB. Depending on pi's core is
therefore not a close call — it is arithmetically impossible under the ceiling, and the
schema validator alone would take 41 % of it.

Source: measured locally on 2026-11-20 against `pi-agent-core@1.5.2`,
`pi-schema@1.5.2`, `pi-ai@1.5.2` from npm.

## Decision

### D19. The budget is a law, enforced by the build

Three budgets, all checked in CI, all failures of the build:

| Budget | Limit | What it covers |
|---|---|---|
| **Bundle** | **≤ 30 000 B gzip**, browser target, minified | the core together with the provider layer — what an application that uses both loads |
| **Layer** | per-layer file counts and code LOC | `core` 1 500 LOC, `schema` 500, `llm` 600, `exchange` 700, `worker` 500, `trace` 400 |
| **Dependency** | **zero** runtime dependencies | the core imports nothing from npm |

The layer budget is expressed in LOC rather than bytes because a byte budget is gamed by
minification, while a LOC budget tracks how much code the browser must evaluate — the
thing that actually costs. The byte budget stays as the outer wall.

The layer budgets are the sums of the module budgets in
[ADR 0005](./0005-core-harness.md) D32, so the two cannot drift apart. Exceeding one
means a module is split or a feature is cut — not that the budget is raised.

### D20. Our own tool-parameter schema dialect, exact by construction

pi-schema's validator costs 12.4 KB of our 30 KB. We write our own instead, and the
difference is not "a subset" — it is **our own dialect that we implement completely**.

- The dialect is a **discriminated union of seven kinds**: `object`, `array`, `string`,
  `number`, `boolean`, `null`, `any`. Every node is fully specified, so the validator
  accepts everything the dialect admits and rejects only what it does not. There is no
  "valid JSON Schema we happen not to support".
- Validation returns an **algebraic result**: `{ok: true, value}` or
  `{ok: false, error: {path, message}}`, where `path` locates the offending node so the
  model can be told what to fix.
- Coercion is **explicit per node**, not implicit. `"42"` becomes `42` only where the
  node says `coerce: true`.
- A conversion to the provider's JSON Schema is part of the dialect, not a side effect:
  every provider accepts the same draft-07 subset, and MiHa produces it from the dialect.

The dialect is a documented artefact, versioned, with its own conformance suite.

### D21. The quality bar, as enforceable properties

What "mathematical, functional, effective, reference-grade" means for this codebase.
Each property is stated so that a machine can check it.

| # | Property | How it is enforced |
|---|---|---|
| Q1 | **No `any`, no `as` casts in `src/`** — every value is typed at the boundary | a lint rule; `as` is allowed only in the adapter layer, where a foreign wire format is being narrowed |
| Q2 | **Every union is discriminated and handled exhaustively** | each `switch` over a union ends in `assertNever`, and `assertNever` is unreachable by construction — a missing arm is a type error, not a runtime surprise |
| Q3 | **Data is immutable** | every exported data type is `readonly`; the core never mutates a message or an event after publishing it |
| Q4 | **Functions are total** | no function returns `undefined` for a domain case; partiality is represented in the type (`Result`, `Option`) |
| Q5 | **Errors are values, not exceptions** — except at the outermost boundary | the core returns `Result`; exceptions are confined to the adapter layer and converted at the seam |
| Q6 | **Invariants are stated and tested** | each law of the core is a named, one-line statement with a test that would fail if it broke |
| Q7 | **The hot path allocates once per event** | no array copying of the transcript in the loop; messages are appended, never rewritten; measured, not asserted |
| Q8 | **No megamorphic call site in the loop** | the tool dispatch goes through one function type, not a union of shapes |
| Q9 | **The dialect's implementation is complete** | the conformance suite covers every dialect kind, every coercion rule and every rejection path |
| Q10 | **No dependency outside `src/`** | the dependency budget check |
| Q11 | **Every exported name has a documented purpose** | the reference surface is small; nothing is exported "for later" |
| Q12 | **Behaviour that can be pinned down is pinned down** | numeric limits, byte budgets, LOC budgets and laws are checked, so "it is fast" becomes "it is 4 KB and 1 000 LOC" |

The point of Q1–Q12 is that "reference implementation" is a **checkable property of a
repository**, not a claim in a README. A reader can clone it and run the checks.

### D22. The law set of the core, with its derivations

The core's correctness is stated as laws, each with a test. Two kinds of law, and the
distinction is the whole point:

- A **derived law** follows from a fact about the provider protocols. It is not a matter
  of taste, and it is not inherited from anyone — it is argued from the protocol.
- A **chosen law** is a policy we decide. It is stated because a policy that is not
  written down is a policy nobody can rely on.

A law with no derivation is a preference wearing the name of a law. Every law below has
one.

#### The tool-parameter dialect: what it admits

This table is the dialect's **admission set**. It is written here so that law C1 can be
falsified from outside the implementation: a value is admitted if the table admits it,
not if the code happens to accept it.

| Kind | Admits | Coercion, when the node says `coerce` |
|---|---|---|
| `object` | a plain object — not `null`, not an array | — |
| `array` | an array | — |
| `string` | a string; if `enum` is given, one of its members | a number or a boolean becomes its text |
| `number` | a finite number; an integer when `integer` is set | a numeric string becomes a number |
| `boolean` | a boolean | `"true"` or `"false"`, in any case, becomes a boolean |
| `null` | `null` | — |
| `any` | anything | — |

Two more rules, which are part of the dialect rather than of one kind:

- **Unknown properties.** `additional: false` rejects them; a schema validates them;
  without `additional` they pass through untouched.
- **Paths.** A rejection names the offending node by an **RFC 6901 JSON Pointer**: `~`
  becomes `~0` and `/` becomes `~1`.

#### Derived laws

| Law | Derivation | Test |
|---|---|---|
| **M1** every tool call of every batch receives exactly one result — never none, never two — including on rejection, tool failure, truncation, provider error and cancellation | the provider rejects the next request whose call has no result, and a transcript with an unanswered call cannot be replayed | one assertion per failure path, and a batch of two calls |
| **M2** a call whose arguments did not arrive complete is never executed; it is answered with an error asking the model to re-issue | the output-token limit truncates the argument stream mid-JSON, and a fragment may parse and validate while being incomplete | a truncated argument string is rejected, never planned |
| **M3** a failed tool is a result carrying `isError`, never ordinary content | the model has to be able to read the failure and recover | a throwing tool and an `isError` tool both produce a result |
| **M4** a provider failure is an event, and M1 survives it: every call the provider streamed is answered and stays in the transcript | a request can fail at any point, and the calls it had already streamed are real | a provider that fails after streaming a call |
| **S1** events are delivered in push order, each exactly once | the stream is the only channel; reordering would make a trace unreadable | one test |
| **S2** `result()` resolves exactly once, with the terminal event's value | a run has one outcome | one test |
| **S3** events pushed after the terminal event are ignored | the run is over; there is nothing to deliver them to | one test |
| **S4** iteration ends after the terminal event has been delivered | a consumer must be able to stop on the terminal event without draining a buffer | one test |
| **S5** no event is lost between a push and the start of iteration | the producer may run ahead of the consumer | one test |
| **S6** a failure ends the iteration by throwing and rejects `result()` | a failure is not a protocol event; it is the absence of one | one test |
| **S7** a close without a terminal event rejects `result()` and ends the iteration without events | a producer bug must surface rather than hang | one test |
| **C1** every value the dialect admits is accepted | a dialect we implement completely must not reject its own values | one test per kind, against the table above |
| **C2** every value the dialect does not admit is rejected, with an RFC 6901 JSON Pointer path | the model can only fix an argument it can locate | one test per kind, plus a property name holding `/` and `~` |
| **C3** coercion happens only where the dialect says so | implicit coercion is how a schema becomes unpredictable | one test per coercible kind |

#### Chosen laws

| Law | Choice | Why |
|---|---|---|
| **T1** an exclusive tool runs alone; the shared tools around it still share a group and run in parallel. Groups run in order | "exclusive" means *must not interleave with another exclusive tool*, not *serialise the turn*. Only the exact value `"exclusive"` is exclusive | the looser reading keeps the common case fast, and the order of the groups is the order of the calls |
| **T2** a steering message is delivered at the next tool-call boundary | delivering mid-batch would interrupt a tool that has already started; delivering after the run ends would lose it | the user is answered at the first moment it is safe |
| **T3** the turn ends when there are no tool calls and no queued messages | one rule, no continuation hook: the loop's exit is a consequence of its state | a hook is a policy the core would then have to own |
| **T4** tool results are recorded in assistant order | the transcript must replay; a live view can still follow completion order, and the two are separate concerns | one order for the record, another for the screen |

Each law has one test, and each test fails when the law fails.

### D23. No fork, no upstream dependency, and attribution where it is due

Public OSS plus "our own" means:

- MiHa's published packages have **zero** runtime dependencies (Q10, D19).
- MiHa does not fork pi. Upstream pi is **read as a specification** and, where its
  behaviour is worth keeping, **its browser-safe test suite is the conformance suite**
  that MiHa's own implementation is written against (ADR 0003 D16). Upstream is MIT; if
  any upstream text or test is reused verbatim, it carries the MIT notice and is
  attributed in `NOTICE`.
- The parts upstream has that MiHa needs on the **backend** side only — an MCP client,
  a provider catalogue, OAuth, server-side storage backends — are taken as **ordinary
  dependencies** of the backend package, not vendored. That is the difference between a
  dependency and a fork, and it is what keeps a public MiHa clean.

## Consequences

**Positive**

- The bundle ceiling becomes a design constraint rather than an aspiration, and the
  measurements say it is the right one: pi's own core would have taken three quarters of
  the budget.
- The quality bar is checkable. A reader of the repository can see which laws hold.
- The dialect is ours, so it is exact: no "valid but unsupported schema" class of bug.
- A public MiHa with zero dependencies is trivially auditable and trivially forkable —
  which is the right posture for something meant to be an example.

**Negative**

- Our own schema dialect is a thing to document, version and maintain, and it is
  incompatible with "the tool schema is just JSON Schema" that a host developer will
  assume. The dialect must be convertible to and from plain JSON Schema.
- Writing the loop ourselves means owning the sixteen behaviours upstream had to
  discover. ADR 0003 D16's test-first order is the mitigation, and it is not free.
- "Zero dependencies" also means writing our own SSE parser, our own partial-JSON
  handling, our own diff for the edit tool, our own tokenizer estimate. Each is small
  and each is a place to get it wrong.

**Neutral**

- The budget forces the argument-streaming decision (ADR 0003 D18) to stay as it is:
  parse once at `toolcall_end`. Live partial-argument rendering would cost 620 LOC of
  subtle parsing, which does not fit the budget it would have to fit inside.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Depend on `pi-agent-core` | 22.9 KB gzip, 76 % of the ceiling, before the provider adapter, the worker host, the exchange and tracing. Arithmetically impossible |
| Depend on `pi-schema` for validation | 12.4 KB, 41 % of the ceiling, for one component. Our own dialect is exact and costs about 2 KB |
| Depend on the AI SDK's schema layer | Not browser-shaped, and it drags the provider tree with it |
| Keep JSON Schema and write a subset validator | The failure mode is "rejects a valid schema" — a permanent liability that a dialect removes by construction |
| Take pi's core as a git fork and trim it | A public fork of someone else's project is a governance question, not only a licensing one. Zero dependencies is the cleaner public posture |
| Keep the budget loose and optimise later | The ceiling is the owner's constraint. A budget that is not enforced is not a budget |

## Out of scope for this ADR

- The loop's structure, which ADR 0002 D2 and ADR 0003 D15 settle.
- The exchange protocol's frame set, which ADR 0002 D9 settles.
- The benchmark suite, which is a later slice.

## Open questions for the owner

1. **The dialect's name and shape.** Should it be a standalone published package, so
   that hosts can write tool schemas against it directly?
2. **How strict is the coercion default?** Strict by default is safer and more
   predictable; permissive by default matches what models actually send.
3. **Does the reference implementation need a TUI?** A reference implementation usually
   ships one, so that its behaviour is observable. That is a budget question.
