# ADR 0015 (draft): What the discriminator found — the wire, the seam and the cancellation

- **Status:** Draft. Proposed by the implementer of the fix wave; the owner records it.
- **Date:** 2026-11-24
- **Refines:** [ADR 0013](./0013-request-seam.md) D70 — the request seam; [ADR 0014](./0014-minimax.md) D71–D76 — MiniMax on the OpenAI-compatible path
- **The claims:** `driver-request-seam` (scope `src/core/loop.ts`, `test/prepare-request.test.ts`, verifier
  `bun test test/prepare-request.test.ts`) and `provider-minimax` (scope `src/llm/`, `test/llm-minimax.test.ts`,
  `test/fixtures/`, `scripts/minimax-smoke.sh`, verifier `bun test test/llm-minimax.test.ts`)

## Context

A discriminator took the two claims of the fieldwork slice apart, and it found **real defects**
in the shipped code and **real gaps in the verifiers** that were supposed to decide the claims.
Both matter, and they are different failures: a defect is the code breaking a law, and a gap is the
law not being checked. A claim with a defect and a weak verifier is the worst of both — it reports
green over code that does not hold.

What the discriminator measured, in its own words:

- a `null` delta becomes the text `"null"`, prepended to the model's answer;
- a tool call whose id never arrives vanishes silently, and the run claims success;
- a later usage record wipes the counts an earlier one reported;
- the options bag can replace the adapter's own fields — the model, the messages, the tools, the
  stream itself;
- the system prompt never reaches the wire at all;
- a cancelled run still calls the provider;
- the seam's wait is not raced against the abort, so a seam that ignores the signal keeps the run
  waiting forever;
- a seam that returns nothing crashes the run;
- the live smoke script puts the provider's key into `curl`'s arguments, where every user on the
  host can read it while the request is in flight.

And the verifier gaps: mutations that survived the verifier, the whole suite and the type checker.

The decisions below are the laws this wave established. Each one names what it is about, and each
one says where it comes from: a fact about the provider's protocol, or a policy we chose.

## Decision

### D82. A delta is a string; anything else is the absence of a delta

The adapter reads a delta only when the wire sent a **string**. `"content": null` is not the text
`"null"` — it is no text at all, and the adapter delivers nothing for that record. The same holds
for `reasoning_content`.

**Derivation.** A fact about the wire: the field is a string or it is absent, and MiniMax's own
records carry `"usage": null` in every chunk but the last, so the wire does use `null` for "nothing
here". Reading a non-string as a delta turns the provider's "nothing" into our "null", and the
model's answer starts with four letters it never said. A delta is the *difference* between two
states; a state that is not a string cannot be differenced.

### D83. A call that never identifies itself is reported, not absorbed

A tool call is identified by its id **and** its name: the id is what the answer must reference, and
the name is what says which tool runs. A call the provider never finishes identifying is reported
as an error — the same shape as a call that arrives without a stream index, which was already
refused. It is not started, and the stream is not reported as a finished answer.

**Derivation.** A failure of the provider's shape is the provider's failure, and law M4 says such a
failure is an **event**, not a silence: the run reports it and the pairing survives. The two
failure shapes are the same shape — a call the adapter cannot correlate — and one of them was
refused while the other was absorbed. Absorbing it is worse than refusing it: the model's request
to call a tool disappears, the run reports `toolUse` with no call in it, and the transcript claims
a success that no one earned.

### D84. The usage of a turn is the largest report of each count, and a count that is not reported is not zero

The wire may report the usage more than once. The adapter merges the reports **per count**: a count
the later record does not mention keeps the value that was already known, and a count that is
reported again is taken as the larger of the two. The counts that the wire spells
`prompt_tokens`/`completion_tokens` win over the `input`/`output` spelling; the fallback is still
read.

**Derivation.** A fact about the wire: a record names the counts it knows and omits the others —
`{"prompt_tokens":10}` after `{"prompt_tokens":10,"completion_tokens":5,"reasoning_tokens":3}` is a
record that repeats the prompt and says nothing about the rest. Reading an omitted count as zero
turns "I am not telling you" into "it was free", and a harness that reports free turns is a
harness nobody trusts. Within one turn the cost only grows, so the largest report of a count is the
truest one; a smaller report cannot be a better tally of the same turn.

### D85. The options bag holds the provider's knobs, and it cannot replace the adapter's fields

The request's options bag is spread onto the wire **first**; the adapter's own fields — the model,
the messages, the tools, `stream`, `stream_options` — are spread after it. The bag can still carry
anything MiHa has never heard of (`temperature`, `max_completion_tokens`, MiniMax's `thinking` and
`reasoning_split`), and it can no longer say which model answers or what the model is told.

**Derivation.** A policy we chose, and the reason is the shape of the bag: it is *opaque* to the
core by design (ADR 0013), so nothing in MiHa reads it and nothing in MiHa checks it. A field the
adapter sets from the core's own request — the model, the messages, the tools — is not a knob: it
is the question. A host that could overwrite it through the bag would be able to ask the provider
something the transcript does not record, and the transcript is the run's only memory (ADR 0008
D46). MiniMax's `reasoning_split` rides in that bag, so the bag must reach the wire; the model must
not be reachable through it.

### D86. The system prompt is the first message of the wire

`ProviderRequest.system` reaches the provider as the **system message** the OpenAI-compatible wire
expects, ahead of the conversation. An empty system prompt is no message at all.

**Derivation.** A fact about the wire, measured against MiniMax on 2026-11-24: a `system` role
message is accepted, and it is how a system prompt travels when it travels. ADR 0014 recorded the
gap and left it open: "the adapter drops the system prompt … This is not a fact about MiniMax — it
is a defect of our adapter, and it is visible against any provider." A harness that sends the user's
messages and the tools but not the instructions is a harness that asks a question the host never
asked. This is a change to `toWireMessages`, which now takes the system prompt and the messages:
the wire's conversation is the system prompt **and** the conversation, and the function that lowers
one of them without the other will lower the wrong thing sooner or later.

### D87. The seam's wait is raced against the run's abort

The driver awaits the seam through a race against the run's signal. When the abort wins, the wait
ends there: the seam's answer is abandoned, and the driver unwinds — the run's task settles, the
abort listener is removed, and the run's own cleanup happens at the cancellation.

**Derivation.** The architecture says the driver "races the cancellation throughout" (§2.4), and
the seam is host code that may wait for a person who does not answer (ADR 0013 D70: "such a wait
must be interruptible, or an aborted run would wait for a host that waits for the abort"). The seam
is given the run's signal so that it *can* stop waiting — but a host that ignores the signal must
not keep the run waiting, and a driver that waits has no end: the `finally` never runs, the abort
listener stays on the host's signal, and the task leaks. The law is about the *driver's* wait, not
the host's: the host is told, and the host may do as it likes with the answer.

### D88. A run that is over does not call the provider

After the seam has answered, the driver reads the phase. When the phase says `finished`, the
request is not performed: the provider is not called at all.

**Derivation.** The seam's `await` is a window between "the core emitted the request" and "the
provider performs it", and the cancellation closes that window. The phase is derived from the
state, never stored in it (ADR 0008 D48), so the driver reads the same label the state says. A
cancelled run that still performs its request spends money on an answer nobody will read, and
reports a turn the transcript does not hold.

### D89. The seam must return a request, and nothing else is prepared

A seam that returns nothing — a host that forgot its `return` — is refused the way a seam that
throws is: the failure becomes a provider error the run reports, and the provider is not called.
The driver checks the shape of what came back (a model, a list of messages, a list of tools)
before it performs anything.

**Derivation.** The seam is host code, and host code returns what it returns. Handing the provider
`undefined` is not a provider failure the adapter can report — the adapter never sees it — so the
driver has to catch it, and it catches it where the seam's failure is caught. The alternative —
performing the core's request because the host's rewrite was missing — is worse than a failure: the
run would look successful and the request would be silently lost.

### D90. The provider's key is never an argument

The live smoke script hands the `Authorization` header to `curl` on its **standard input**
(`curl -K -`), not on its command line. The key is still never printed and never written to a
file.

**Derivation.** A fact about the host, not about the provider: every user on a machine can read
the process table, and an argument is in the process table. The discriminator measured it with
`ps -eo args` while a request was in flight: the key was readable by every user on the host for
the life of the request. A configuration on standard input is not in the process table, so it is
not in `ps`. The shell expands the key into a here-document, so no process ever receives it as an
argument.

## What the evidence says

The two claims were re-measured with a sweep of 26 mutations — 12 against the seam's claim and 14
against the provider's — each applied to an isolated copy of the tree. **Every one of them is
caught with exit code 1** by the claim's verifier as it stands.

The mutations that had survived before this wave, and where they are caught now:

| Mutation | Caught by |
|---|---|
| the rewrite reaches only the first turn | `test/prepare-request.test.ts` — the two-turn rewrite |
| the options bag is dropped before the seam | `test/prepare-request.test.ts` — the seam sees the bag |
| the seam gets the outer signal, not the run's merged one | `test/prepare-request.test.ts` — the live signal, aborted at the run's end |
| the standard usage spelling loses to the fallback | `test/llm-minimax.test.ts` — both spellings, two tests |
| the fallback spelling stops working | `test/llm-minimax.test.ts` — the fallback test |
| a cut-short stream is reported as a stop | `test/llm-minimax.test.ts` — the `length` test |
| a record with text and thinking delivers only one | `test/llm-minimax.test.ts` — the record with both |
| the calls are correlated by arrival | `test/llm-minimax.test.ts` — the interleaved stream |
| the request does not ask for the usage | `test/llm-minimax.test.ts` — the body of the request |
| a later usage record wipes the earlier counts | `test/llm-minimax.test.ts` — the two usage records |

And the defects, each with the mutation that would bring it back:

| Defect | Mutation | Caught by |
|---|---|---|
| a `null` delta becomes the text "null" | the `typeof` guard removed | `test/llm-minimax.test.ts`, `test/llm.test.ts` |
| a call that never identifies itself vanishes | the report removed | `test/llm-minimax.test.ts`, `test/llm.test.ts` |
| the options bag replaces the adapter's fields | the spread moved last | `test/llm-minimax.test.ts` |
| the system prompt never reaches the wire | the system dropped | `test/llm-minimax.test.ts` |
| a cancelled run still calls the provider | the phase check removed | `test/prepare-request.test.ts` |
| the seam's wait is not raced against the abort | the race removed | `test/prepare-request.test.ts` |
| a seam that returns nothing crashes the run | the check removed | `test/prepare-request.test.ts` |

The two controls already recorded in `spec.json` still break their verifiers with exit code 1, and
they were not replaced.

## Consequences

- The adapter now reads the wire the way the wire writes it, and the request it sends is the
  question the host asked.
- The driver's waits end at the cancellation, and a cancelled run costs nothing.
- `toWireMessages` takes the system prompt as well as the messages: a change to the published
  shape of `src/llm/`, and one a host that lowers requests itself has to follow.
- The smoke script no longer puts a key where every user on the host can read it.

## What a reviewer should argue with

- **D84's merge rule.** "The largest report wins" is a policy, not a protocol fact. A provider that
  reported a *delta* rather than a total would be counted wrongly. The alternative — "the later
  report wins, per count" — is defensible too, and it is one line away.
- **D87's race and D88's phase check overlap.** The race closes the window the phase check closes,
  and the phase check closes a window the race cannot (an abort that lands between the race's
  settlement and the provider's call). Both are kept because the phase check is the readable form
  of the law and the race is what makes the wait end; a reviewer who wants one mechanism should say
  which, and the sweep would have to be redone.
- **D89's shape check is shallow.** It asks whether the answer looks like a request, not whether it
  is a *correct* one. A seam that returns a request with the wrong model is still performed. The
  deep check would be the core's dialect, and the core does not see the seam's answer.
- **The claim `provider-minimax` still has assertions outside its scope.** Four of them live in
  `test/llm.test.ts`, which is the verifier of two other claims. The orchestrator decides whether
  to widen the verifier or move the assertions; this implementer did neither, and said so in the
  claim's note.
