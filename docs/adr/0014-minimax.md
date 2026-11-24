# ADR 0013 (draft): MiniMax on the OpenAI-compatible path — the endpoint, the quirks, and the capture

- **Status:** Draft. Proposed by the implementer of slice S9; the owner records it.
- **Date:** 2026-11-24
- **Refines:** [ADR 0005](./0005-core-harness.md) D24, D32 — the adapter never throws and never rejects
- **The claim:** `provider-minimax` — scope `src/llm/`, `test/llm-minimax.test.ts`, verifier
  `bun test test/llm-minimax.test.ts`

## Context

MiHa's provider layer speaks one dialect: the OpenAI-compatible chat-completions wire.
MiniMax serves that dialect, so the question was never "can MiHa talk to MiniMax" but
"what does MiniMax's dialect actually look like, and where does our adapter's
assumption about it break".

The answer was measured, not read. The owner's key is a **coding-plan** key (the prefix
`sk-cp-`), and a note in another repository says such a key is refused by
`api.minimax.io` with `401 invalid_token`. The note could not be reproduced: the key
answers there. What is true is different, and less comfortable: the key is configured,
elsewhere, against the **Anthropic-compatible** path
(`https://api.minimaxi.chat/anthropic/v1`), and that path does not serve
`/chat/completions` at all.

Three candidates were tried, once each, with one minimal non-streaming request:

| Candidate base URL | Status | Usable for the OpenAI path |
|---|---|---|
| `https://api.minimax.io/v1` | 200 | **yes** — the documented international endpoint; this coding-plan key answers here |
| `https://api.minimaxi.chat/v1` | 200 | yes — the same answers, under the other international domain |
| `https://api.minimaxi.chat/anthropic/v1` | 404 | no — that path serves a different URL space (`/messages`), and an OpenAI-shaped POST is not found there |

So the endpoint is not the interesting part. The interesting part is that MiniMax's
stream is a legal OpenAI stream with **three departures** from what our adapter
assumed, and each of them silently destroys something:

1. the stream never sends `data: [DONE]`;
2. the usage is spelled `prompt_tokens` / `completion_tokens`, not `input` / `output`;
3. the last record of the stream — the usage — carries `"choices":[]`.

Against the unmodified adapter, a MiniMax answer ended as **an error**: "the provider
closed the stream without a terminal event", with a usage of zero. Not a crash, not a
wrong number — a provider that looks like it failed. That is the failure mode law M4
is about, and it is why the slice was worth a capture.

## Decision

### D71. The base URL of the OpenAI-compatible path is `https://api.minimax.io/v1`, and the note that says the coding-plan key is refused there is stale

The key answers with HTTP 200 on the documented international endpoint, with a normal
completion, with tools, with usage and with thinking. `https://api.minimaxi.chat/v1`
answers the same way. The Anthropic-compatible path answers 404 to an OpenAI-shaped
POST, because it is a different API, not a different door to this one.

**Derivation.** A fact about the provider, measured on 2026-11-24 with one minimal
request per candidate. The note that says otherwise was not reproduced, and a decision
may not rest on a note that the measurement contradicts. The owner decides which of the
two working URLs the harness configures; the harness must not depend on the choice,
because both are the same service.

### D72. A stream ends when the provider says the message is finished — a `finish_reason`, not only a `[DONE]`

A chunk whose choice carries a non-null `finish_reason` ends the stream, whether or not
a `[DONE]` marker follows it. A stream that ends with neither is still an error, as
before.

**Derivation.** A fact about the provider: MiniMax's OpenAI-compatible stream ends
after the usage record and never sends `[DONE]` (D76). The marker is not the provider's
only way of saying "the message is finished" — `finish_reason` is the other way, and it
is the one OpenAI itself puts in the chunk. Requiring the marker made every MiniMax
answer look like a stream that was cut short, and a provider that looks broken is
worse than one that looks slow: the run ends, the transcript shows an error, and
nothing says that the model had already answered.

The error for a stream that ends without either signal is unchanged, because a stream
that says nothing about its ending is still a stream that was cut short.

### D73. The usage is read from the wire's own spelling, and the reasoning tokens are part of the completion tokens

`prompt_tokens` is the input, `completion_tokens` is the output,
`completion_tokens_details.reasoning_tokens` is the reasoning, and
`prompt_tokens_details.cached_tokens` is the cache read. The spellings `input` and
`output` are still read, for the gateways that use them; the standard spelling wins
where both are present.

**Derivation.** A fact about the wire: the OpenAI-compatible chat-completions usage is
`prompt_tokens` and `completion_tokens`, and MiniMax follows it — measured, and the
capture in D76 shows it. The adapter read `input` and `output`, so it counted a
MiniMax answer as free: not a wrong number displayed, but a number that was never
counted.

The reasoning tokens are a **part** of the completion tokens, not an addition to them:
the wire counts them in `completion_tokens` and names them in the details, and the
OpenAI and Anthropic wire formats agree. So `output` is the whole completion and
`reasoning` is the part of it that was thinking. The cached prompt tokens are the ones
the provider read from its cache, which is what the core calls a cache read.

### D74. The thinking arrives as `delta.reasoning_content` only when `reasoning_split: true` is asked for; otherwise it is inlined in `delta.content`

**Derivation.** A fact about the provider, measured on 2026-11-24: with
`reasoning_split: true` the thinking arrives in its own field (with a `reasoning_details`
companion); without it, the thinking is inlined in the content, wrapped in `<think>`
tags. Our adapter reads `delta.reasoning_content`, so the thinking reaches the core as
a reasoning delta only under that flag. The flag is a provider knob and the options bag
carries it verbatim, so a host asks for it in the options — the adapter needs no
knowledge of it.

The default is worth stating plainly, because it is a trap: without the flag the
thinking is *text*, and a harness that renders the content renders the model's private
reasoning as its answer.

### D75. The `thinking` parameter of this path takes `{"type":"adaptive"|"disabled"}`; the Anthropic-style `{"type":"enabled","budget_tokens":…}` is refused with HTTP 400

**Derivation.** A fact about the provider, measured: the answer was
`400 invalid params, invalid thinking.type: "enabled" (allowed: adaptive, disabled)`.
The Anthropic-shaped form is what other tools send, and it is what this path refuses.
`adaptive` is the default and lets the model decide; `disabled` turns the thinking off
and the answer arrives without it.

### D76. The capture is the evidence: three fixtures under `test/fixtures/`

The bytes MiniMax sent are kept verbatim, and the claim is proved over them. The three
captures cover the three things that can go wrong:

| Fixture | What it holds |
|---|---|
| `minimax-m3-stream.sse` | the thinking as `delta.reasoning_content`, the text, `finish_reason: stop`, and the usage in a record with `"choices":[]` |
| `minimax-m3-tool-call.sse` | one tool call, its arguments split across four fragments, `finish_reason: tool_calls` |
| `minimax-m3-two-tools.sse` | two calls in one message, indexes 0 and 1, with interleaved fragments — the capture that makes "correlated by index" mean something |

The captures hold the provider's answers and nothing else: no key, no account data, no
request. Nothing had to be redacted.

**Derivation.** The house rule: a change is a claim before it is code, and the claim
needs a machine that decides. A live provider cannot be a verifier — it is slow,
unrepeatable and billable — so the evidence is the capture, and the capture is real
bytes from the provider rather than a hand-written approximation of it. The
two-tool-call capture exists because a one-call capture cannot tell "correlated by
index" from "correlated by arrival", and a claim that cannot tell them apart is a
claim about nothing.

## What was measured but not decided here

- `temperature` is **accepted** (HTTP 200). Whether it has any effect was not measured,
  and nothing in MiHa depends on it.
- `max_tokens` and `max_completion_tokens` are both accepted, and both are honoured
  (a request that hits the limit ends with `finish_reason: "length"`). The docs call
  `max_tokens` legacy; on this path it still works. The thinking tokens count toward
  the limit, so a limit must leave room for them.
- `tools: []` is accepted, so the adapter's habit of sending an empty tool list is
  harmless here.
- A `system` role message is accepted, which is how the system prompt must travel if
  it travels at all — see the gap below.

## The gap this slice did not close

**The adapter drops the system prompt.** `ProviderRequest.system` is never put on the
wire: the body carries the model, the messages, the tools and the options, and nothing
else. This is not a fact about MiniMax — it is a defect of our adapter, and it is
visible against any provider. It is out of this slice's claim (which is about the
stream, not the request) and it is left for the owner to assign.

It is recorded here because a reader of D71–D76 could otherwise conclude that "MiHa
works against MiniMax" means "a MiHa run behaves as MiHa is meant to behave". It does
not yet: the model gets the user's messages and the tools, and it does not get the
instructions.

## Consequences

- The adapter no longer requires a `[DONE]` marker, and no longer counts a provider's
  usage as zero. Both were wrong against the standard wire, not only against MiniMax.
- The reasoning tokens and the cached prompt tokens are now counted. A harness that
  showed "0 tokens" for a MiniMax run was not showing the truth.
- The capture is committed, so the claim is decidable without a network and without a
  key.

## Alternatives considered

- **Send `stream_options: { include_usage: true }` only to providers that document
  it.** Rejected: it is accepted on this path, and the usage is worth having.
- **Require the `[DONE]` marker and treat MiniMax as unsupported.** Rejected: the
  provider finishes its messages, and an adapter that calls that a broken stream will
  call every well-behaved provider broken, one at a time.
- **Ask the provider for a thinking model that streams `reasoning_content` by
  default.** Rejected for now: `reasoning_split: true` is one option in the options
  bag, and the capture shows the adapter already speaks the field.
