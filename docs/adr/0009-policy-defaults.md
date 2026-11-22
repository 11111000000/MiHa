# ADR 0009: The three policy defaults

- **Status:** Accepted
- **Date:** 2026-11-22
- **Owner:** petr p.b.kosov@yandex.ru
- **The design:** [docs/architecture.md](../architecture.md) §5 — the host sets the policy, the core enforces the law

## Context

The architecture names five budgets. Three of them are host policy with no default:
`turnLimit` is a required field every embedding must choose, the result budget is
designed (ADR 0006 D34) but not built, and the resident window is a law (R1) whose
mechanism (the windowed journal, ADR 0008 D45) is not built either. An embedding that
must choose a number before its first run gets the number wrong.

A default is not a law; it is a starting policy, and rule 8 of this repository applies
to it as to everything else: **every default states its derivation.** Two of the three
get a mechanism and a claim in this ADR's wake. The third does not, and says so.

## Decision

### D50. The result budget defaults to 8 192 bytes, head and tail kept, the cut announced

`resultBudget?: number` joins the harness config; the default is 8 192. The core
truncates every tool result whose text exceeds it — failures, rejections and the
synthetic answers of a failed provider included — keeping the first half and the last
half of the bytes and inserting a block that names the numbers:
`[result truncated: N of M bytes omitted]`, where N is what was **actually** dropped,
not what the budget allowed. Non-text blocks pass through untouched.

The edges are decided, not left to the code:

| The host says | The core does |
|---|---|
| `Infinity` | no truncation at all |
| `0` | nothing is kept but the announcement |
| a negative number, or `NaN` | the default — nonsense gets the safe number, not an unbounded result |
| a number | the budget, honoured exactly |

The **live progress channel** is budgeted the same way: a tool that reports a megabyte
of partial output does not put the memory law at the mercy of the tool. What reaches
the transcript, the turn's events and the provider's next request are all the same
budgeted bytes — the model's context is bounded by one rule, not by four.

**Derivation.** A policy we chose, anchored to two facts we measured or cited: the
cumulative token cost of results grows quadratically with turns (≈3 350·N²,
[research 05](../research/05-alternative-architectures.md), arXiv:2609.22114), so the
per-result byte count is the linear factor of the dominant cost; and 8 192 B is a
quarter of the whole bundle ceiling (30 000 B gzip, ADR 0004) — a single tool result
should never approach the price of the harness itself. Head and tail, because a
document's schema lives at its top and its summary at its bottom.

**Open edge, stated.** The budget governs text; image blocks pass through. Images are
bounded by the host that produced them, not by this core. When image results appear in
practice, this decision is revisited.

### D51. The turn limit defaults to 32

`turnLimit?: number` becomes optional; the default is 32. Zero is honoured: the run
makes no provider request at all and ends with `limitReached` naming zero. A negative
limit or `NaN` is nonsense and gets the default.

**Derivation.** The median real task runs 16.2 turns across 17.4 tool calls
([research 05](../research/05-alternative-architectures.md), arXiv:2509.24002, MCPMark,
127 tasks). Twice the median — a task and a full retry — rounds to 32: enough to finish
the common task, low enough that a runaway loop is bounded before its quadratic token
cost compounds.

### D52. The resident window defaults to 64 entries — decided, not yet enforced

The window's default is 64 journal entries: about a median task resident (16.2 turns ×
~4 entries per turn ≈ 65), so the common task never waits on the host's persistence.

**This is a decision, not a claim.** The windowed journal does not exist yet (ADR 0008
D45); a default without its check is a wish, so no claim is declared and no number
ships in code. When the journal lands, 64 is the starting policy and the claim arrives
with it.

## Consequences

**Positive**

- An embedding runs with no configuration beyond the provider and the tools.
- Every result that reaches the transcript — however it was produced — passes one
  seam, so the model's world is bounded by one rule rather than by four.
- The result budget is enforced at the one seam every result crosses — including
  failures and rejections — so the model's world stays bounded whatever a tool returns.

**Negative**

- A default is a guess with a citation. Both D50 and D51 are revisited after the first
  runs against a real provider (ADR 0008 §8, item 8).
- Truncation destroys information the host may have wanted. The full result existed —
  in the tool, before the core saw it — and the host that needs it whole can raise the
  budget or disable it; what it cannot do is read it back from the transcript.
