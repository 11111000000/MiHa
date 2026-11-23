# ADR 0011: The receiving side of the exchange

- **Status:** Proposed
- **Date:** 2026-11-23
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0008](./0008-final-architecture.md) D49 — the receiving side is this protocol read from the other end; [ADR 0007](./0007-peer-boundary.md) D43 — a frame we do not know is ignored, and a task that is not ours is not ours
- **The design:** [docs/architecture.md](../architecture.md) §2.5 — the receiving side is `delegate()` read from the other end

## Context

ADR 0008 D49 decided the shape of the receiving side: accept or refuse, run one's own
agent on the task with one's own tools, send one's events back — the same journal
entries — and end with a result. The delegating side existed; this end did not, and
the plan called the missing half "this code read from the other end".

Two things were missing. One of them was in the code that was already there.

**The wire had two vocabularies.** The `event` frame carried a live `AgentEvent` —
the vocabulary ADR 0008 D45 had retired in favour of the journal entry. With one
vocabulary the wire carries the journal's entries, and the delegating side forwards
entries rather than events. The payload type changes; the delegating side's
behaviour does not, and its claim stays true.

**The end of a run is not the end of the journal.** The core hands the host its last
entries **before** the terminal event: the driver flushes what the final turn had
queued as the machine finishes, so a consumer that closes its journal on the
terminal event keeps every entry of the run. That promise is about the *journal*,
though, and not about the *work*: the machine can be finished while one of our own
tools is still winding down after an abort — the tool is still ours, it may still
be doing something, and the peer is owed the truth about it. The receiving side has
to know when the run has *really* ended, not when the machine said so.

The rest of the decision is the protocol read from the other end: a task is offered,
a task is taken or refused, the run happens, and the outcome ends it.

## Decision

### D59. The wire carries journal entries, and the receiving side sends them as they are written

The `event` frame carries a `JournalEntry` — the run's own log — and not a live
event. The receiving side wraps the host's `append` hook: every entry the run wrote
is handed to our host first (it is the one that keeps them) and then sent to the peer
as an `event` frame, in the order the entries were written.

The receiving side's own view is that same log: `events` is the sequence of entries
the run wrote, and it is what the peer receives.

**Derivation.** ADR 0008 D45: one vocabulary, and the journal entry *is* the durable
event. Two vocabularies that agree by convention drift apart under change, and a
peer that receives a translated event has to trust the translation. The log does not
need translating: the peer receives the entries the run wrote, with the sequence
numbers the run gave them.

### D60. The receiving side is told which task it accepts

`receive()` is given the `taskId` it will accept. A frame for another task is not
ours and is ignored — an offer, and a cancel alike.

**Derivation.** ADR 0007 D43: a task that is not ours is not ours. The id is a
name both sides agreed on before the task was offered, and it is what keeps two
tasks on one link apart: the receiving side answers about the task it was asked
about, and nothing else.

### D61. A task is refused with a reason, and a peer of another version is refused

Three refusals, and all of them carry a reason:

- **The host may refuse the task.** `decide(offer)` answers `{kind: "refuse", reason}`
  or `{kind: "accept"}`. A refusal without a reason is not a refusal the peer can act
  on: it is a shrug, and the reason it is given is a stated one.
- **An offer whose `version` is not `protocolVersion` is refused.** The peer speaks
  another protocol, and half-understood is worse than refused.
- **An offer that carries no task is refused.** There is nothing to run, and a run
  with nothing to run is not a task.

A host that cannot decide at all — its `decide` hook throws — is refused too, and
the failure is the reason: a host that cannot answer has not answered, and the peer
is not left waiting for a decision that is not coming.

A refusal posts a `refuse` frame and ends the task as a failure carrying the reason.
A task that is taken posts an `accept` frame before the run starts, so the peer can
tell *slow* from *refused* (ADR 0007, the `accept` frame that was kept).

**Derivation.** ADR 0007 D42: the version is in the offer so that a peer speaking
another protocol is refused rather than half-understood. And a reason is a fact: the
delegating side turns the refusal into a failure whose error is the peer's reason,
so the reason has to be there. A task is a task when it says what to do, and a host
that cannot decide is a host that must still answer — one way or the other.

### D62. The result frame ends the task, and it goes after the last entry

The core hands the host its last entries **before** the terminal event, so the peer
hears every entry of the run before it hears that the task is over. The guarantee is
the core's, not this side's: a peer that closes its journal on the result keeps
everything.

The result frame carries the run's own outcome, verbatim, and it is sent last.

The core's order is about the journal and not about the work: the machine may be
finished while one of our own tools is still winding down after an abort. So the
receiving side does not send the result when the stream ends. It sends it when **our
own calls are done** — our provider and our tools, wrapped so that the receiving
side can see them finish.

**Derivation.** The peer closes its journal when the result arrives: the delegating
side resolves the task there, and an entry that arrived after the result would be
lost. The receiving side's own calls are the only thing that can hold the driver
open — the driver breaks out of the provider's stream when the machine finishes, but
it waits for a tool that is still running. A task therefore ends when the run ends,
and not when the machine says so.

### D63. A peer's cancel stops the run, and the outcome is the run's own

A `cancel` frame from the peer aborts the run through the driver's signal, and the
task ends as the run ended: cancelled. A `cancel` that arrives **before** the offer
means the peer withdrew the task: no run starts and nothing is accepted, and the
task ends as cancelled — the peer hears the result, and it is not left waiting for
an answer about a task it no longer wants.

The outcome is never invented — the result frame carries the outcome the run ended
with, and a run that ended without one (the host misbehaved) is a failure carrying
the error.

**Derivation.** The core's cancellation is total: every live state can reach
`finished` (ADR 0005 D25), and the run's own outcome says which ending it was. A peer
that cancels wants the run stopped, not a guess about how it stopped. And a task the
peer withdrew is not a task this side takes: accepting it would answer a question
the peer has already withdrawn.

### D64. Our tools and our policy are ours, and the peer's offer cannot change them

The receiving side runs the task with the config and the host it was given — never
the peer's. The peer's offer carries a task and a context; it cannot carry a tool,
and a frame of an older protocol that asks for one is ignored.

The host's `approve` seam applies to the receiving side's own tools, exactly as it
applies to any run: the peer does not widen the seam, and the peer never sees it.

**Derivation.** ADR 0007 D41: a peer gets a task, never a capability, and the
permission seam stays where the decision was made (ADR 0008 D44). An offer is data,
not an instruction: the receiving side reads the offer's fields, and runs its own
agent.

### Consequences

**Positive**

- The protocol has one vocabulary in both directions: a delegated task is a fact in a
  log, and the peer can read the entries the run wrote (ADR 0008 D49).
- The receiving side is small: it is the delegating side read from the other end,
  plus `runAgent`.
- The task ends when the run ends and our own work is done, and the last entry
  reaches the peer before the result that ends it.

**Negative**

- The receiving side wraps its own provider and its own tools, to see when they
  finish. That is bookkeeping the layer would not otherwise have, and it exists
  because the core's terminal event says that the *machine* is done, and not that
  the *driver* is.
- A tool that never settles holds the task open, and the peer waits. That is the
  truth — our own work is not done — but it is a wait the peer cannot see.
- The peer learns the outcome only after the last entry and after our own calls
  are done, so a tool that is slow to stop delays the answer.

**Neutral**

- The receiving side is told which task it accepts (D60). A link that carries many
  tasks at once needs one receiving side per task.
- The receiving side returns a handle at once, and stays quiet until the peer
  offers: the handle's `events` and `outcome` say what happened once there is
  something to say.

## Open questions for the owner

1. **Should the receiving side learn the task id from the offer?** It is told now
   (D60), which keeps the filter crisp. The other shape — one receiving side per
   link, taking whatever is offered — needs a rule for what happens to the second
   offer.
2. **Should the host be able to refuse with more than a reason?** A refusal may
   carry a declaration of what this side can do ("data, not compute"), which the
   peer could show to its own user. The frame carries a string today.
