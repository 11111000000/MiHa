# ADR 0018: The fieldwork — a live run

- **Status:** Accepted
- **Date:** 2026-11-24
- **Owner:** petr p.b.kosov@yandex.ru
- **Refines:** [ADR 0016](./0016-interface-layer.md) · [ADR 0014](./0014-minimax.md)
- **The design:** [docs/architecture.md](../architecture.md) — the harness, embedded

## Context

Every claim in this repository so far has been proven against a script, a double or a
capture. The harness had never been run against a real provider, and the bundle number
had never come from an application that actually embeds it. `docs/architecture.md`
promised an embeddable harness and a budget measured in situ; neither had been
measured in situ.

## Decision

### D101. The harness runs against MiniMax-M3

A live run, with the real provider, the real bridge, the real approval seam and the
real journal:

```
--- outcome ---
{"kind":"completed"}
--- journal ---
message 1        the prompt
message 2        MiniMax-M3's answer
tool_call 3      the model asked for a tool
tool_result 4    the tool ran in the page and its answer came back
message 5        the model's final answer
```

The human was asked before the tool ran, and allowed it. The key was read from the
environment, given to the page's field in memory, and never written to a file: the
example's own verifier checks that no file of the example mentions `localStorage`,
`sessionStorage`, `indexedDB`, `document.cookie` or an `sk-` pattern.

The run was driven from Node, over the browser's own wiring — the page's half, the
worker's half, and the harness's worker host between them — because the shared
browser's session expired between the agent's calls. The page itself loads in a real
Chromium; the run inside its worker has not been driven from the browser's keyboard
yet, and this ADR does not claim it.

### D102. The bundle is measured in situ

`examples/browser/` builds with `bun build --target=browser` — no bundler
dependency — and the result is **14 836 B gzip** for the whole application: the page
(2 541 B), the worker (12 295 B), the harness, the provider adapter, the exchange and
the interface layer. The ceiling is 30 000 B.

The numbers quoted before this were the synthetic ones (the core alone, re-exported
through a synthetic entry): **8 102 B** for the core, **9 708 B** with the provider
layer. They were stale in the documentation, and are corrected.

### D103. The defaults are still borrowed

The run was one task. The budgets — 8 192 B for a result, 32 turns, 64 entries of
window, 128 KiB of context — are still the ones ADR 0009 derived from other people's
measurements. Nothing in this run changes that; what it changes is the *confidence*:
the harness runs, the provider answers, the tool is called through the bridge, the
human is asked, and the journal is written.

## Consequences

**Positive**

- The harness is not a diagram any more: it answered a real model, called a real
  tool, and finished with `completed`.
- The budget that matters — the whole application, in situ — is measured, not
  estimated: 14 836 B against 30 000 B.

**Negative**

- One run is not a measurement. The defaults are still guesses with citations, and
  the honest next step is a hundred tasks, not another feature.
- The run in a real browser's worker is unproven by this ADR: the shared browser's
  session expired between the agent's calls. The page loads; the worker's run was
  driven from Node over the same wiring.
- The capture of that run was not recorded as a cassette, so the run cannot be replayed
  yet — the cassette records the provider's responses, and the run was driven live.
