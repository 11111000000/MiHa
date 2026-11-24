# ADR 0019: Where the journal lives when the harness runs in a worker

- **Status:** Accepted
- **Date:** 2026-11-24
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0008](./0008-final-architecture.md) D45 · [ADR 0016](./0016-interface-layer.md)
- **The design:** [docs/architecture.md](../architecture.md) §2.1

## Context

The harness runs in a worker in the browser's usual placement: the page owns the
interface and the tools, the worker owns the loop. That raises one question the
journal makes sharp — **where does the durable record live?**

Two vocabularies used to answer it: the live events (what the interface renders) and
the journal (what the run *is*). ADR 0008 D45 retired the first as a durable
vocabulary, so the question has one answer left: the journal is the record, and the
live events are the view.

## Decision

### D104. The journal is written where the run happens, and the entries cross to the page

The worker's host persists the journal — the `append` hook runs in the worker, with
the worker's own storage ✓. The **entries** cross to the page as frames, as they are
written, and the page keeps them if it wants them ✓.

The live events cross too, and they are the view: they are ephemeral, they may
arrive in a different order than the entries (the journal's hook is synchronous, the
event stream is not), and an application that wants one timeline has to order the
two itself — the entries carry their sequence, the events do not.

**Why not the other way round.** The page's storage is the page's business, and the
worker's is the worker's; a record that lives in the page and is written by the
worker is a record that can be lost when the worker is restarted, and a harness that
must ask the page for its own history cannot fold forward without a round trip.

### D105. The journal is the harness's own, and the host may keep it

The core does not know where the journal is written. A host that runs the harness in
the page writes it there; a host that runs it in a worker writes it there; a host
that wants it in both can write it in both — the entries are the same, and a
duplicated record is the host's business, not the core's.

## Consequences

**Positive**

- One durable vocabulary everywhere: the journal, the trace, the peer's view of a
  delegated task, and the session are all the same entries.
- The worker may be restarted: the run's record is wherever the host put it.

**Negative**

- An application that renders one timeline must order the entries and the events
  itself. The entries carry their sequence; the events do not.
- The page's copy of the journal is a copy. If the page and the worker disagree, the
  worker's is the truth — the page's is the view.
