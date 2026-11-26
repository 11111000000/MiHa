# ADR 0020: Embeddable first — the peer is an optional layer

- **Status:** Accepted
- **Date:** 2026-11-24
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0008](./0008-final-architecture.md) (the host surface) · supersedes the *framing* of [ADR 0002](./0002-core-harness.md) (the shape: "decentralised" as a first-class property) · the boundaries of [ADR 0007](./0007-peer-boundary.md) and [ADR 0011](./0011-receiving-side.md) remain binding
- **The design:** [docs/architecture.md](../architecture.md) §1, §2.6, §2.7

## Context

The repository's positioning made the peer a first-class property: the README called
MiHa "a harness for the frontend, with a symmetric peer on the backend", the plan's
shape diagram drew a backend peer beside the frontend, and AGENTS.md opened with
"hands work to a backend peer and takes it back". Meanwhile the verified facts on the
ground are:

- **the core never imports the exchange.** No file under `src/core/` references
  `src/exchange/`. The layer is removable, and an embedding that never mentions a
  peer runs the full loop — the browser example's own runs complete without one.
- **the exchange is 515 lines** of the 700-line budget, with no authentication, no
  reconnection, and no queue before the link is open (ADR 0017). A protocol in that
  shape cannot go on the open internet: it belongs on channels their owner controls.
- **a protocol's value is the number of its speakers.** The wire is semantically a
  subset of A2A (a task, opaque execution, a declaration), invented separately. It is
  an interface between two instances of *this* harness — which is legitimate when
  both ends are yours, and useless the moment a peer is somebody else's agent.

The question is not whether delegation is real — a browser agent cannot reach
secrets, databases or heavy compute, and handing a task is the only way to get there.
The question is what the record promises.

## Decision

### D106. The harness is embeddable first; the peer is an optional layer

The positioning changes everywhere the record speaks: MiHa is an **embeddable agent
harness for browser applications**; the peer layer is **optional**, added when the
agent needs what a page cannot reach. `docs/plan.md`'s fifth property becomes
**Optional** — and it is machine-checked: `test/peer-optional.test.ts` asserts that
no file under `src/core/` imports the exchange, and that a run completes with no
peer installed. AGENTS.md, the README, the architecture document and the site say
"optional".

### D107. The wire is an in-house interface, and interop is an adapter

The exchange protocol is an **interface between two instances of this harness**, for
links their owner controls — not a standard, and not a promise to the world. The
boundary it enforces (a task, never a callable handle; ADR 0007) is
protocol-independent and stays. When interop with other agents is needed, an adapter
behind `ExchangePort` carries the same six frames over the other protocol's
transport — the boundary and the guarantees do not move. No adapter is built now:
the target protocols are young, and the harness needs a working boundary, not a
dialect card.

### D108. The transport authenticates nobody, so it runs on trusted channels only

The transport has no authentication layer. That is a **deployment law**, recorded
rather than hidden: the exchange runs on trusted channels — localhost, a LAN, a VPN,
a link behind an authenticating proxy — and is not exposed to the open internet
until an auth layer exists. Making auth a separate slice is deliberate: an auth
seam's shape (who authenticates — the socket, the first frame, a token in every
frame) is a decision that needs a real deployment in front of it.

### D109. The old framing is superseded, not erased

ADR 0002's diagram and the plan's early text describe the peer as the shape of the
whole project. Those documents keep their history; this ADR supersedes the framing.
What remains binding: the task boundary (ADR 0007), the receiving side (ADR 0011),
the transport's reporting law (ADR 0017).

## Consequences

**Positive**

- The simple embedding story is light again: a page, a worker, a provider, tools —
  no protocol required to explain the first run.
- The peer's real reason is stated without inflation: delegation is how a browser
  agent reaches what a page cannot, and both ends running the same harness make the
  second one nearly free.
- The optionality is checked, not claimed: a future import of the exchange into the
  core breaks the gate.

**Negative**

- A protocol with one speaker is a dialect. Its speakers are the owner's own
  applications — Genium and Geopulse — and that is the only ecosystem it will ever
  have unless the adapter is built.
- No auth means the deployment surface is trusted channels, and nothing else, until
  someone builds the auth layer.
- The site, the README and the plan carried numbers and a diagram from earlier eras
  (the 5 103 B core, the removed `call`/`answer` frames); this ADR's pass corrects
  them, because a repositioning that syncs the story but not the facts is a new
  story with old lies.
