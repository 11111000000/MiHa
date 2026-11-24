# The browser example

The harness, running in a browser. Nothing else: no framework, no bundler
dependency, and no runtime dependency at all.

```
examples/browser/
  index.html      the page: the prompt, the live view, the journal, the key
  page.ts         the page's half of the application — no DOM, so a machine can drive it
  page.entry.ts   the DOM: the panes, the dialog, the worker
  worker.ts       the worker's half: the harness, the tools, the approve seam, the peer link
  worker.entry.ts the worker's global scope, and the harness in it
  frames.ts       the frames the two halves speak
  tools.ts        the page's tools, and the directory they work on
  peer.ts         the peer link, in memory
  provider.ts     MiniMax, over the OpenAI-compatible path
  build.sh        the build, and the size of what it produced
  measure.mjs     the gzipped size, and the ceiling it must fit in
  smoke.sh        build, measure, and fail if the ceiling is passed
```

## Running it

```sh
examples/browser/build.sh          # writes examples/browser/dist
cd examples/browser/dist
python3 -m http.server 8000        # or any static server
```

Then open `http://localhost:8000/`. The page asks for the provider's key; the key
is read from the field, kept in memory, and handed to the worker. It is never
written to a file, never bundled, and never sent anywhere but the provider.

Ask the agent to `read notes.txt`, or to `echo hello`, and watch the three panes:
the run on the left, the journal in the middle, the peer on the right. Every tool
call opens a dialog first — that is the harness's one permission seam, and the
page asks the human.

## What it shows

- **The placement.** The harness is in the worker; the application's interface is
  in the page. The worker cannot reach the DOM, the storage or the page's files,
  so everything the agent needs from the application goes across the capability
  bridge.
- **The page owns the tools.** The catalogue travels to the worker with the run,
  and the worker builds one tool per entry of it. The agent cannot call a tool
  the page never offered — the list it gets *is* the list the page sent.
- **The permission seam is asynchronous.** The worker asks the page, the page
  asks the human, and a refusal is an ordinary answer the model reads: the run
  continues.
- **The journal is the durable record.** Every entry the run writes reaches the
  page as it is written.
- **A peer gets a task, not a handle.** The page may offer a task over the peer
  link; the peer runs it with its own tools, and its journal comes back.

## The size

```sh
examples/browser/smoke.sh
```

The bundles are measured the way `scripts/check-budget.mjs` measures the
harness's own: gzipped, level 9. The ceiling is the same number — 30 000 B —
and the page's bundle and the worker's bundle are counted together, because a
browser downloads both.
