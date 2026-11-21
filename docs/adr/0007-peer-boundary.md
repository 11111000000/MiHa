# ADR 0007: The peer boundary — a task, not a capability

- **Status:** Accepted
- **Date:** 2026-11-20
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0002](./0002-core-harness.md) D30, [ADR 0005](./0005-core-harness.md) D30, [ADR 0006](./0006-alternatives.md) D36
- **Research base:** [research 05](../research/05-alternative-architectures.md) §4

## Context

ADR 0005 gave the exchange a **symmetric** shape: the delegator offers a task, and the peer
may call the delegator's tools back. The evidence gathered afterwards says that shape is
the one weakness in the design.

Cognition's principle for agent-to-agent work is *"Share context, and share full agent
traces, not just individual messages"*, and *"Actions carry implicit decisions, and
conflicting decisions carry bad results"* (<https://cognition.ai/blog/dont-build-multi-agents>).
A peer that calls our tools acts on a decision it cannot see: it does not know which
affordances we chose to expose, how we phrased them, or what has already been tried.
The measured cost of acting on a badly-informed view is real — making tool descriptions
*strictly more informative* cost **+67.46 %** steps and regressed **16.67 %** of cases
(arXiv:2602.14878).

The protocols in this field all draw the line the same way:

| | What crosses the boundary |
|---|---|
| **A2A** | *"without needing access to each other's internal state, memory, or tools"*; opaque execution; an **Agent Card** — a declaration |
| **MCP** | the one server→client operation is `sampling/createMessage`, which asks for an *LLM generation*, not a tool call; and *"Applications SHOULD always have a human in the loop with the ability to deny sampling requests"* |
| **AG-UI** | attribution (`subagentRunId`, `parentToolCallId`) and **no** orchestration |

All three carry **declarations and attribution**. None carries a callable handle into the
other side's tools. Ours did.

The owner has decided: **remove the direct peer call.**

## Decision

### D41. A peer may not call the delegator's tools

The `call` and `answer` frames are gone. The exchange is now a **task delegation**, in
both directions:

```
delegator --offer(task, context)--> delegate
delegator <--event, result------- delegate
```

The delegate runs the task with **its own** tools and reports what happened. The
delegator's tools stay private to the delegator, and so does its reasoning.

The capability is not lost, it is expressed as a task. When the backend agent needs the
browser to press a button, it hands the frontend agent the *task* «press the submit
button»; the frontend's agent does it with the frontend's own tools, and the
permission hook applies on the frontend side, where the decision was made.

### D42. The offer carries the task, the context, and the protocol version

The offer is `{version, taskId, task, context?}` and nothing else. It does not name our
tools, because it cannot reach them; it does not carry our transcript, because that is
our business.

The version is there so that a peer speaking another protocol is refused rather than
half-understood. A frame we do not recognise is ignored.

### D43. A frame we do not know is ignored, and a task that is not ours is not ours

Two filters, both in the delegating side:

- A frame whose `taskId` is not ours is not ours.
- A frame whose kind we do not know — a `call` from an older peer, for instance — is
  ignored rather than trusted.

## Consequences

**Positive**

- The exchange matches every protocol in the field, and the argument for it is written
  down rather than assumed.
- The delegating side is simpler: no tool registry in the delegation options, no
  dispatch path for a foreign call, no second permission surface. The exchange layer
  shrank from 239 to 151 code lines.
- The permission seam stays where the decision is made. A peer can never widen it.
- A peer can no longer act on a decision it cannot see, which was the measured risk.

**Negative**

- The frontend agent can no longer be used as a remote actuator. If a product needs the
  backend to click a specific button *without* the frontend agent deciding to, that
  capability is gone. The task route exists, but the frontend agent decides.
- A peer of an older version silently receives no answer to a call it still makes. The
  protocol version makes this detectable in the offer, but a peer that ignores it will
  wait.

**Neutral**

- The exchange is now one-directional in its *capability*, and symmetric in its
  *tasks*. That is not a contradiction: both sides may offer a task, and neither may
  reach into the other's tools.

## Out of scope for this ADR

- The receiving side, which is the same code read from the other end.
- The transport and the reconnection policy.
- Whether a task should carry a *declaration* of what the delegate may do — for
  instance a page affordance list. It is a question for the receiving side.

## Open questions for the owner

1. **Does a task carry declarations?** If the frontend agent is to act on a page, the
   backend needs to say what it believes the page offers. A declaration is not a
   capability — but it is a description of the delegator's world, which is exactly what
   the evidence says a peer needs to act correctly.
2. **What happens to a call from an older peer?** Today it is ignored. Perhaps it should
   be refused with a reason, so the peer learns rather than waits.
