# ADR 0012: The cassette — the recorded provider, and the replay

- **Status:** Proposed
- **Date:** 2026-11-23
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0008](./0008-final-architecture.md) D46 — the trace is the journal
- **The design:** [docs/architecture.md](../architecture.md) §2.1 and §6 — the trace layer holds the provider responses only

## Context

ADR 0008 D46 retired the separate trace format: the trace **is** the journal. What that
leaves is the one half of the exchange the journal cannot hold. The journal holds what
the model said and what the tools answered; the stream in between — the deltas that
became the assistant's message — is not in it, and it cannot be derived from the log.
A run recorded against a live provider therefore cannot be replayed without the
provider's answers, and those answers are the other half of the exchange.

So the cassette holds exactly that half. The hazard is symmetry: a recording that also
kept the run would be a second trace, and two traces disagree — under a change, under a
truncation, under anything. One artefact to store, ship and replay is the reason D46 was
decided, and a cassette that copies the journal undoes it.

The second hazard is the replay that lies. A request the recording does not hold has to
be said so. If the replay answers with an empty stream instead, the run looks like one
in which the model had nothing to say, and the gap in the recording is invisible exactly
when it matters.

The third is the key. A recording keyed by something that changes between two builds of
the same request is not a recording: the replay diverges from a run that never diverged,
and the divergence report points at the recording rather than at the run.

## Decision

### D65. The cassette holds the provider's responses and nothing else

The cassette is a map from the key of a request to the events the provider produced for
it. It holds no messages, no journal entries, no tool results and no request — and the
key is a hash, so it holds no text either (D66).

**Derivation.** ADR 0008 D46: the trace is the journal, and one artefact is stored,
shipped and replayed. A copy of the run inside the cassette would be a second copy of
the transcript, and a second copy is a thing that can disagree with the first. What the
journal cannot hold is the provider's responses; what the journal can hold, it holds.

### D66. The key is a 64-bit hash of a canonical form of the request

The canonical form **tags the types**: a number and its name are different things
(`5` is not `"5"`, and `NaN` is not `"NaN"`). Without the tags, two different requests
share a key, and the replay answers one with the other's recording — silently, with no
divergence to show for it.

The key covers **what the provider is asked**: the model, the system prompt, the
messages (their role and their content, and for a tool result the call it answers), the
tools (name, description and parameters) and the options.

The key does **not** cover what the provider answered last time (the usage and the stop
reason of the previous turn) and what the interface showed (a tool result's `details`).
Neither is part of the question being asked.

The canonical form is JSON with every object's keys sorted, so the key does not depend
on the order in which the host happened to write an object down. The hash is FNV-1a and
djb2 together — 64 bits, sixteen hex digits — and no dependency and no crypto.

**Derivation.**

- *A hash, not the request.* A key that carried the request's text would put a second
  copy of the transcript inside the cassette, which D65 forbids. The key identifies the
  request; it does not repeat it.
- *A canonical form, not `JSON.stringify`.* The request is built from objects the host
  fills in — the tool's parameters are a map, and a map's order is not part of the
  schema. `JSON.stringify` would make the key depend on that order, so the same
  request built twice would be two requests and a replay would diverge from a run that
  never diverged. Sorting the keys is what makes "the same request" mean the same
  request.
- *Two hashes of 64 bits.* A cassette holds thousands of requests at most. A collision
  at that size is not a thing that happens — but this is the one decision here that is
  probabilistic, and a reviewer is entitled to argue for a longer key.

### D67. A key may hold several answers, and a request the recording does not hold is a divergence

A run may ask the same question twice. The cassette therefore holds a **list** under
each key, and the replay answers the n-th ask with the n-th recording — so two runs
recorded into one cassette each replay to their own journal. One answer per key would
make the second run replay to the first run's journal, silently.

A request the recording does not hold — and a cassette of another version, which is
not answered at all — is a divergence, and it is reported.

The replay answers a request from the recording and gives the recorded events back
unchanged. A request the recording does not hold is **not** answered: it produces a
divergence, naming the request — its key, the model, the number of messages and what the
last one said.

**Derivation.** An empty stream is indistinguishable from a turn in which the model had
nothing to say. A transcript that ends a turn without an answer reads like a run, and
the gap in the recording stays invisible exactly when the recording is what the reader
is relying on. A divergence that is not reported is not a divergence; it is a wrong
answer.

### D68. The divergence travels the provider's own error path, and the replay keeps the list

The replay yields the provider's `error` event with the divergence's message, so the
core treats it as what it is — a provider failure — and the run writes it into the
journal (law M4). The replay also keeps the divergences it has seen, in order, so a host
can read them without reading the journal.

**Derivation.** The trace is the journal (D46), so a divergence that is not in the
journal is a divergence nobody reads. And a failure in this harness is a value in the
stream, not an exception thrown beside it: the driver must not reject because a
recording was incomplete, or the host would have to choose between an exception and a
silent failure.

### D69. The cassette is plain data, and the layer depends on no adapter

The cassette is handed out as a **snapshot**: the recorded arrays are copied, so a
cassette taken mid-run does not keep growing under the reader's feet. A view of a
running recording is not a cassette.

The cassette is `{ version, responses }` — JSON-serialisable, with no functions and no
classes in it. The layer wraps the provider at the host's `callProvider` seam and
imports nothing from `src/llm/`.

**Derivation.** The cassette is stored and shipped (D46), so it has to survive JSON.
And a cassette that knew the adapter would hold wire formats rather than the provider's
answers: the record/replay mode is a property of the harness, not of a vendor's
protocol, and a second vendor would otherwise need a second cassette.

**Consequences**

- A recorded run replays to the same journal — the same entries, in the same order — and
  a diverging run names the request that differs.
- The cassette is portable: JSON in, JSON out, zero runtime dependencies.
- The key is probabilistic (D66), and the layer's guarantee is "the same request has the
  same key", not "no two requests ever share one".
- The retention of a cassette is still open (ADR 0008, open question 2): how long the
  responses are kept, and whether they leave the device, is a product decision.
