# ADR 0013: The request seam — the host rewrites the request in flight

- **Status:** Proposed
- **Date:** 2026-11-24
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0008](./0008-final-architecture.md) — the driver's intents, and the seventh host hook; [ADR 0006](./0006-alternatives.md) D35, which named this seam and left it unbuilt
- **The design:** [docs/architecture.md](../architecture.md) §2.4 and §2.6 — the driver performs the intents, and `prepareRequest` is one of the seven hooks the host provides

## Context

The core fixes the `ProviderRequest`: the model, the system prompt, the folded context,
the tool list and the opaque `options` bag. Everything a host wants to change *about
the request itself* has no place to happen — elide a stale result, switch the model for
one turn, attach a deadline, force a compaction on overflow, retry one transient
provider error. The host's only influence today is the `options` bag, and a bag the core
never reads is not a seam; it is a note.

ADR 0006 D35 named the answer and priced it: one optional function on the host, called
by the driver between "the core emitted a `provider_request`" and "the host performs it".
It was the cheapest item on the alternatives list and it unblocked the most. It was also
never built — the promise was made in the alternatives ADR, the final architecture
repeated it, and the code had no such thing. The host surface already lists
`prepareRequest` as one of the seven hooks (§2.6); the hook had no implementation.

The alternatives were narrow, and every one of them is worse:

- A second request builder **in the core** puts a policy in the machine. The core is a
  pure transition function (ADR 0006 D31), and the host owns the policy (ADR 0008 D44).
- A **middleware chain** around the provider client moves the decision out of the
  driver, where the cancellation and the pairing live.
- **Editing the `options` bag** cannot express "drop the last tool result" — the bag is
  opaque to the core by design, and making it legible would make the core's request
  depend on what the host stuffed into it.

One requirement is hard. A seam is host code, and host code throws. A host whose seam
throws must not cost the run its transcript: the calls it had already made are answered
(law M1), and the failure has to be reported rather than swallowed.

## Decision

### D70. The host may rewrite the request in flight

`HarnessHost` gains one optional member:

```ts
readonly prepareRequest?: (
	request: ProviderRequest,
	signal: AbortSignal,
) => ProviderRequest | Promise<ProviderRequest>;
```

The driver calls it **once per provider request**, after the core has produced the
request and **before** the provider performs it. The provider receives **exactly** what
the seam returned — the very object, not a copy of it, and not the core's request. The
seam may be synchronous or asynchronous; the driver awaits it either way, because a host
that has to ask something must not be asked to answer synchronously.

The seam is given the **run's signal**, so a host that waits can see the abort and stop
waiting.

A seam that throws does not take the run down. The failure becomes a **provider error
event** — `{ type: "error", message }` — on the same path the `openai-compat` adapter
uses for a transport failure. The run reports it, the calls the transcript already holds
stay answered (law M1), and the provider is **not** called: a request that could not be
prepared never became one.

A host without the seam changes nothing: the provider receives the core's request, as
the core built it.

**Derivation.**

- *The driver, not the core.* The core fixes the request and hands it over as an intent
  (ADR 0006 D31); the driver is where the provider is called (ADR 0008 D46, §2.4). A
  seam inside the core would be a policy in the machine, and the machine has none — the
  host owns the policy (ADR 0008 D44). The seam therefore sits in the one place that
  already performs the request.
- *Exactly what the seam returned.* The request that reaches the provider and the
  request the host rewrote must be the same thing. A copy would be a second truth: the
  host would rewrite one request and the provider would answer another, and the
  transcript would not say which.
- *A failure is an event, not an exception.* Law M4: a provider failure is an event, and
  the pairing survives it. The seam's failure is a provider failure — the request never
  reached the provider, so no adapter can report it. The `openai-compat` adapter already
  turns a transport failure into `{ type: "error", message }`; the seam's failure
  travels the same road, and the run ends the way a provider failure ends it.
- *The signal, because the seam may wait.* A host that rewrites a request may have to
  ask: a person's permission to send it, a clock, a cache. Such a wait must be
  interruptible, or an aborted run would wait for a host that waits for the abort.
- *Absent means absent.* The seam is optional, and a host without one pays nothing:
  the driver hands the core's request to the provider, unchanged.

**Consequences**

- The browser can now act on the request — elide a stale result, switch the model for
  one turn, attach a deadline, force a compaction, retry one transient failure —
  without the core knowing or caring.
- The core is untouched. The seam is a driver detail; the request the core builds is
  still the request the core believes it asked, and the journal still records what the
  model was told.
- The seam can do nothing else. It sees one request and one signal: it cannot reorder
  the journal, cannot answer a call, and cannot see the core's state (§2.6).
- A host that installs the seam pays for it on every turn — a rewrite is a decision
  made per request, not per run.
- The seam's power is the host's. A host that rewrites the request wrongly gets a
  provider that answers a question the run never asked, and the transcript shows what
  was sent, not what was meant.
