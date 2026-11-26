# ADR 0021: The peer link authenticates

- **Status:** Accepted
- **Date:** 2026-11-26
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0020](./0020-embeddable-first.md) D108 · [ADR 0011](./0011-receiving-side.md) · [ADR 0017](./0017-tool-timeout-and-host-digest.md)
- **The design:** [docs/architecture.md](../architecture.md) §2.7

## Context

ADR 0020 D108 recorded the transport's limit as a deployment law: the exchange
authenticates nobody, so it belongs on trusted channels — localhost, a LAN, a VPN —
until an auth layer exists. The layer now exists, and this ADR is its decision.

The threat the layer answers is concrete: anyone who finds the WebSocket URL can
connect, offer tasks, and have the backend run its tools inside the host's policy.
On a link without authentication that is not an attack, it is the protocol working
as written.

## Decision

### D110. The handshake travels before any task frame

A port created with a token sends a handshake as the **first** message over the
wire, before anything the layer above asks it to carry:

```
both ends open → { miha_auth: token } → { miha_auth: token } → link authenticated
```

Until the link authenticates, incoming frames are **dropped and the link is
closed**, with one failure report. A stranger's frames on this link are a
misconfiguration or a probe; either way nothing crosses in either direction.

The handshake is a **transport message**, not a protocol frame: it carries no
`kind`, `isExchangeFrame` rejects it, and the layer above never sees it. The
protocol stays six frames; the authentication is the transport's own.

### D111. The token is a shared secret held by both ends

Both ends of the link hold the same token, set by the owner, in memory. A link
between ends that disagree on the token carries **nothing** and is closed with a
failure report; a link between an end with a token and an end without one carries
nothing either way — the token is link-wide, both ends or neither.

**The assumptions, stated.** The handshake sends the secret once over the wire, so
an unencrypted `ws://` link is replayable by a listener: the exchange belongs on
`wss://` whenever the channel leaves the machine. The compare is constant-time, so
the link does not leak the token's length or content through timing. The secret is
held in memory by both ends and never written, logged or bundled — the same rule
the browser example's verifier enforces for the provider's key.

### D112. The compare never leaves the token's shadow

The token comparison runs over every byte of both encodings and folds the
differences into one accumulator: an early exit on the first differing byte would
let a peer measure how much of the token it guessed.

## Consequences

**Positive**

- The exchange is no longer open to strangers: a peer without the secret cannot
  offer a task, cannot deliver a frame, and cannot even have its frames ignored —
  the link closes on the first unauthenticated byte.
- The deployment law softens from "trusted channels only" to "encrypted channels
  plus the token": `wss://` and the secret are the whole configuration.

**Negative**

- The secret is now in two places (both ends' memory), and a host that loses it
  loses the link.
- The handshake is one message of trust: an attacker who *is* the owner of the
  token is inside, by definition. This layer answers "a stranger connected", never
  "the token leaked" — that is a rotation problem, and rotation is not built.
- A link between ends that disagree on the token is dead by design, and the
  failure report is the only trace.
