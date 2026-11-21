# The discriminator, and parallel work

The method proves a claim by running **one** mutation of the subject and watching the
verifier fail. That is a floor, not a proof: the verifier may catch the mutation the
control names and nothing else, and the claim may say things nobody can check.

A **discriminator** is an agent whose job is to close that gap. It does not confirm the
work. It tries to break it.

## What a discriminator does

For each claim it is given:

1. **Read** the claim: its text, its subject, its falsifier, its verifier, its control.
2. **Read** the subject** and work out what the verifier actually checks — and what it
   does not.
3. **Invent mutations** the claim's text forbids, *different from the claim's own
   control*. Prefer plausible ones: the change a future maintainer might really make.
4. **Test each** in an isolated copy. Record whether the verifier **caught** it, let it
   through, or hung.
5. **Report**. It does not edit the subject, and it does not commit.

### The three findings worth having

| Finding | What it means |
|---|---|
| **A hole** | the verifier passed a mutation the claim forbids. The claim is under-specified, or the verifier is too weak |
| **A false law** | the shipped code already breaks the claim's text. The claim is wrong about the code |
| **A vacuous law** | the claim cannot be falsified at all, because it is defined by the implementation it describes |

The third is the worst and the quietest. `dialect-laws` used to say "every value the
dialect admits is accepted" — and the admission set *was* the implementation, so nothing
outside could refute it. The fix was to write the admission set down
([ADR 0004](./adr/0004-quality-bar.md) D22) and point the claim at that table.

## What a discriminator reports

A table, and nothing else:

| claim | mutation | verifier outcome (caught / **not caught** / hung) | severity |
|---|---|---|---|

Then, for every **not caught** row: the exact command, why the claim's text forbids it,
and what the law would have to say to be enforceable. Then the strongest holes, ranked,
with the smallest patch that closes each. Then the claims whose *text* is
under-specified, with better wording. Then what could not be tested, and why.

A discriminator that cannot break anything says so plainly. That is worth as much as a
finding.

## The rules

1. **It never edits the subject.** It reports; the owner decides. A discriminator that
   fixes what it finds has taken the decision away from the owner and destroyed the
   evidence.
2. **It works in a copy.** `/tmp/opencode/disc-*`, never the repository.
3. **It commits nothing.**
4. **A hanging verifier is a finding.** It is recorded as a hang, and it is treated as a
   defect of the test, not of the subject.

## What a discriminator found here

The first run over the bridge and the core produced 47 mutations: 26 caught, 21 not.
Four of the uncaught ones were **the shipped code already breaking the claim**:

| Claim | What was true |
|---|---|
| `bridge-closed` | `client.call("toString")` resolved. A plain property lookup finds `Object.prototype`, so the closed set leaked |
| `run-laws` | a cancelled run gave one call **two** results: the real one and a synthetic "cancelled" |
| `run-laws` | a provider failure after streaming a call dropped the call entirely — neither answered nor recorded |
| `run-laws` | the external `AbortSignal` did nothing at all; the "cancelled" outcome came from the run running out of work |

And one of the claims it examined was **not** real: the discriminator reported that the
driver ran the tool groups in parallel. The second agent, working from the code, found
that the driver had always run them in order. A discriminator that is wrong is
correctable; a discriminator that is never wrong is not looking.

## Parallel work

Work may run in parallel when the **claim scopes do not overlap**.

That is not a stylistic rule. The evidence is bound to a digest of the scope's files, so
two agents editing one file are both changing the same evidence, and the second one's
commit invalidates the first one's proof. Disjoint scopes are disjoint evidence.

The rules:

1. **One file, one agent.** If two slices need the same file, they are not parallel.
2. **The core is frozen while the layers above it are built.** The worker host, the peer
   exchange and the trace layer depend on the core's shapes; none of them may change them
   while another is building on them.
3. **Every agent runs the gate on its own branch**, and the merge runs it again.
4. **The specification is the owner's.** `spec.json` and the decisions are edited by one
   hand. An agent proposes a claim or a control; the owner records it.
5. **Two heavy checks at a time.** This host has four cores and eight gigabytes, and
   several agents live on it. The gate is light — a few seconds — and can run
   concurrently. A full build or a type-check sweep cannot.

## The order that works

The method needs the subject to exist before it can refute a claim, so the order is:

1. **Write the test.** It fails, because the thing it tests does not exist yet.
2. **Declare the claim** over the test and the subject. The first run **refutes** it —
   and that refutation is the method catching a real defect.
3. **Implement** until the verifier passes.
4. **Run** the gate.
5. **Send it to a discriminator**, before the claim is considered settled.

Step 5 is what this repository did not do for its first claims, and the discriminator
found four real defects in code whose every control was proven.
