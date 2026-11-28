# ADR 0010: The context policy

- **Status:** Accepted
- **Date:** 2026-11-23
- **Owner:** petr p.b.kosov@yandex.ru
- **The design:** [docs/architecture.md](../architecture.md) §2.2 and §5 — the host sets the policy, the core enforces the law

## Context

Law R1 says the core's resident memory is O(window + context + one result),
independent of the length of the run. Two of those three terms were bounded: the
journal keeps a window of 64 entries (ADR 0009 D52) and one result is budgeted
(ADR 0009 D50). The third — the context — grew with the run, because the fold
kept every message the run had produced.

The fold already knew how to collapse a range into a summary entry; what was missing
was the policy: **when** to collapse, and **what** the summary says.

## Decision

### D54. The context budget defaults to 128 KiB, and the core collapses what does not fit

`contextBudget?: number` joins the harness config; the default is 131 072 bytes. The
core measures the folded context in bytes of text and, at the end of a turn, when the
context is over the budget, it collapses the oldest range that does not fit into a
**digest** entry and keeps what follows. The journal keeps the whole history: a
compaction is a fold, not a deletion.

**Measured on our own tasks** (113 of them, against a real model:
[research 06](../research/06-measurements.md)): the largest context was 8 KiB and no
task needed a compaction — this budget never fired once either. It is a bound, and
lowering it to the measured p90 × 4 would compact runs that need no compacting, and
compaction is lossy.

**Derivation.** A policy we chose, anchored to the measurement we have: the median real
task runs 16.2 turns and 17.4 tool calls ([research 05](../research/05-alternative-architectures.md),
arXiv:2509.24002), and a turn of our own conversation — a prompt, an assistant message
with its call, and the answer — is a few hundred bytes. A median task therefore fits
in well under 64 KiB, and 128 KiB is twice that: the common task never compacts, and a
long one does. The budget is in bytes because the core has no tokenizer and no model
(ADR 0006 D29), and a byte is the unit the result budget already speaks.

### D55. The digest is mechanical, lossy, and says so

The digest is one line per collapsed message — the role and the first 120 characters —
prefixed by how many entries were collapsed. It is marked `[compacted]`, so the model
knows it is a summary and not the thing itself.

The room is split: the entries that follow take the budget, and the digest takes at
least a quarter of it and then whatever they leave. The digest is cut to that room in
**bytes**, prefix included, and never inside a codepoint — the same rule the result
budget follows (ADR 0009 D50), because a broken character in the model's context is
worse than a short digest.

**What follows alone may exceed the budget.** The core cannot shrink the entries that
remain — they are the current turn — so a context whose last entries are larger than
the budget stays over it, and the law says so rather than pretending otherwise. The
first request is the same case: a prompt bigger than the budget is the exception.

The digest always has room to say something. When the entries that follow fill the
budget on their own, the digest still names what it swallowed — a summary that says
nothing is no summary, and the exception already covers the overflow.

### D56. A host that can summarize better replaces the digest

The digest is mechanical because the core has no model and no clock. A host that can
ask the model to write a better summary does so and replaces the digest with a
`change` entry — the history is untouched, and the model sees the better summary.

### D57. A call is recognised by its entry, not by its name

A compaction that swallows a question swallows its answer too: an answer whose question
the model cannot see is an orphan, and an orphan is not context. The fold knows which
answer belongs to which question by the **entry** that asked — not by the call's name,
because a name may be reused in a later turn, and a reused name is a different call.

### D58. The collapse runs after everything the turn put into the context

The collapse happens when the turn is over and everything it produced is in the
context — the answers, and a message the user steered in. A collapse that ran before
the steered message would leave the request over the budget, with a legal way to fit
unused.

**Consequences**

- The context is bounded, and with it the resident memory: the second half of law R1
  becomes true, and the three terms of the law are all bounded by a number.
- The digest is lossy, and the model is told so. A run whose task depends on the exact
  wording of an old message needs a host that summarizes better (D56).
- The measurement is in bytes, so the budget is not the provider's window. A host that
  cares about tokens sets the budget from its own count.
