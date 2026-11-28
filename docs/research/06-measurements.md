# 06 — Measured: a hundred and thirteen tasks against MiniMax

- **Date:** 2026-11-28
- **Method:** [scripts/measure-tasks.ts](../../scripts/measure-tasks.ts) over [scripts/tasks.txt](../../scripts/tasks.txt)
- **Raw data:** [06-measurements.json](./06-measurements.json)
- **Why:** the defaults of the harness were derived from other people's measurements
  (ADR 0009 D50, D51; ADR 0010 D54). This is our own.

## What was run

113 tasks, each one a real request to the real provider: the harness, the example's own
three tools (`read_file`, `list_dir`, `echo`), the real journal. The model was
**MiniMax-M2.5-highspeed** — the cheapest and fastest of the models this account may
use (MiniMax-M2 and MiniMax-M2.1 are gone from the API; M3.1-Flash refuses every
request without thinking; the M3 flagship is four times the price of the Flash tier).

Six tasks at a time, each measured alone: the provider requests it made, the turns it
took, the journal it wrote, the size of the folded context at the end, the largest
single tool result, the compactions it needed, the tokens the provider reported, and
the wall time.

## What it cost

| | median | p90 | max |
|---|---|---|---|
| provider requests | 3 | — | 5 |
| turns (requests after the first) | 2 | 3 | 4 |
| the folded context, bytes | 2 058 | 4 090 | 8 179 |
| the largest tool result, bytes | 89 | 89 | 489 |
| input tokens | 1 934 | — | 4 659 |
| output tokens | 211 | — | 1 428 |
| wall time, ms | 22 461 | 36 607 | — |

All 113 tasks ended `completed`. None of them needed a compaction.

## What it says about the defaults

| Default | Was | Measured | Verdict |
|---|---|---|---|
| the turn limit | 32 | max 4 turns | **stays.** Our tasks are simple; the literature's real tasks run 16.2 turns (arXiv:2509.24002). The limit is a bound for a runaway, and lowering it below the literature's median would cut real work short |
| the context budget | 128 KiB | max 8 KiB | **stays.** The budget is a bound, not a target: 6 % of it is what a four-turn task uses. Lowering it to "the measured p90 × 4" would compact runs that need no compacting — and compaction is lossy |
| the result budget | 8 192 B | max 489 B | **stays**, for the same reason: the budget exists for a tool that returns a whole file, and a normal answer never comes near it |

**The honest summary: all three defaults are bounds, and none of them fired once in 113
real tasks.** That is the right shape for a bound, and it is also a measurement of what
the harness costs in the common case: three provider requests, two kilobytes of
context, twenty-two seconds.

## What it does not say

These are short tasks with three small tools. The literature's real tasks (16.2 turns,
17.4 tool calls, arXiv:2509.24002) are longer, and a long task's context grows; our
numbers bound the *simple* case, not the hard one. The defaults were not moved on the
strength of this measurement, and they should not be: what this run shows is that the
bounds do not fire early, which is exactly what a bound is for.

## Reproducing it

```sh
echo 'MINIMAX_API_KEY=…' > .env     # never committed; see .gitignore
bun scripts/measure-tasks.ts         # 113 tasks, six at a time
```

The key stays in the environment and in memory. The harness never writes it, and the
browser example asks for it in the page.
