# ADR 0015 (draft): the interface layer — the registry, the flat spec, the patches, and the tree

- **Status:** Draft. Proposed by the implementer of slice S12; the owner records it.
- **Date:** 2026-11-24
- **Refines:** [ADR 0008](./0008-final-architecture.md) §2.6 and §8.7 — the interface layer, "if the agent is to draw interfaces"; answers its open question 3, the `block` entry's visibility
- **The claims:** `ui-spec-laws` — scope `src/ui/`, `test/ui.test.ts`, verifier `bun test test/ui.test.ts`;
  `ui-registry-laws` — scope `src/ui/registry.ts`, `src/ui/tree.ts`, `test/ui-registry.test.ts`, verifier
  `bun test test/ui-registry.test.ts`
- **The layer:** `src/ui/` — 407 code lines of a budget of 800 (ADR 0004 D19), no runtime dependency, no `any`

## Context

An application embeds MiHa and gets an agent loop. So far the loop's output has been
text and events, and the application's interface has been the application's own code:
it renders the journal, and the agent's words reach the screen as words.

That is enough for a chat. It is not enough for an application that wants the agent to
*draw* — to compose a panel, a table, a form — inside its own interface, with its own
components and its own look. The architecture names this as the last piece to build
(§8.7) and gives it a budget of about 800 lines, and it says what the piece is for:

> the agent may *draw* — a component registry (what the host's interface is made of),
> a **flat spec** (what the agent asks for: a list of components with their properties,
> no code, no expressions), and **patches** (how the host turns a spec into its own
> components). The layer produces a **tree** — a plain data structure the host renders
> with its own machinery.

Two words in that paragraph carry the whole risk.

**No code.** The spec crosses a trust boundary that the rest of MiHa is careful about.
A tool call crosses it as *validated arguments*: the core parsed them and checked them
against a dialect, and the tool received the checked form (ADR 0008 D47). A spec that
could carry an expression, a script or a function would cross the same boundary
unchecked — and it would cross it into the user's page, which is exactly what the one
permission seam exists to prevent (ADR 0008 D44). A drawing layer whose failure mode
is "the model's text became code in the host's DOM" is not a feature.

**Flat.** The spec is not a tree of nested objects. It is a list. The word matters
because it decides where the checking happens: on a flat list, every element is
checked on its own, against one closed set, and there is no recursive schema whose own
rules could be wrong at some depth.

And one question ADR 0008 left open for this layer: **the `block` entry's visibility**.
A denial is recorded for the model and for the audit; whether the interface renders it
as a first-class event or folds it into the tool result is a UI-layer decision. This
ADR answers it (D98).

## Decision

### D91. The layer is four things, and it knows nothing about the provider

- **the registry** — the closed set of the host's components: a name, the properties
  each accepts, and the properties each cannot do without;
- **the spec** — the agent's request: a flat list of components, each with a name and
  its properties;
- **the patches** — the host's way of substituting its own components for the names
  the agent uses;
- **the tree** — what the layer produces: plain data, deterministic, serialisable.

The layer takes the agent's output — the text it wrote, or a structured request — and
produces a tree. It reads no provider, no journal, no clock and no randomness. It does
not know what a model is, and the tree it produces says nothing about where the spec
came from: the same spec gives the same tree whether a model wrote it, a tool
returned it, or the host's own code built it.

**Why.** The architecture puts the interface layer above the core and beside the
adapters, and the house rule is that a layer may import the ones below it and never
the ones above (ADR 0002 D1). A layer that read the journal would not be an interface
layer; it would be a second projection, and the journal already has one.

### D92. A spec is data: the format's vocabulary is closed, and a value that is not data is refused

A spec is a plain object with two keys, `version` and `components`. A component is a
plain object with four keys: `id`, `name`, `props` and `parent`. **Any other key is
refused**, at either level, and the refusal names the key. A property's value must be
data: a string, a finite number, a boolean, `null`, or an array or a plain object of
data. A function, a symbol, a bigint, a date, a map, a class instance, `NaN` and an
**accessor** are all refused.

An accessor is refused *without being called*. The layer reads a property's descriptor
and never reads the property itself, so a getter in a spec never runs — the check does
not become an execution. A property named `__proto__` is refused wherever it appears,
and the copies the layer makes are made with `defineProperty`, so a prototype cannot
be changed by a key.

**Why.** The whole purpose of the layer is defeated by one smuguggled function, and the
place a smuggle is most likely to hide is a key the format does not declare: the
format's own vocabulary is the smallest closed set that can carry a drawing, and every
key outside it is refused rather than ignored — an ignored key is a key the host will
one day render.

The property that decides it is not the function but the **getter**: a plain value
check that reads the property would call the getter and then refuse it, which means
the check runs the code it is checking. Reading descriptors is what makes "the spec
carries no code" true rather than nearly true.

### D93. The spec is flat: a list of components, and a parent that names another component

The components are a list. A component says which component it sits under by naming
that component's `id` in its `parent`. The tree is built afterwards: the roots are the
components without a parent, and the children of a component are the components that
name it, in the order of the spec.

Two components may not share an id, a parent must name a component of the spec, and a
parent chain that loops is refused — a loop has no tree, and following it would not
terminate.

**Why.** Flatness is what makes the checking total (D92): every component is checked
on its own against one closed set, and there is no recursive schema whose own rules
could be wrong at some depth. The alternative — a nested spec — would make the *shape*
of the spec recursive, and the shape is the part an untrusted writer controls most.

The tree has **roots** and not one root: a spec may draw several things at once, and
the layer does not invent a wrapper. A wrapper would have to be a component name, and
the registry is closed (D94) — the layer cannot invent a component the host does not
have.

### D94. The registry is the closed set, and it holds no renderer

The registry is a map from a name to a component: the properties the component accepts
and the properties it requires. A spec that names a component the registry does not
have is refused; a spec that carries a property the component does not declare is
refused; a spec that leaves out a required property is refused. The registry is a
`Map` and not an object, because an object lookup finds `Object.prototype` — a
registry built from a plain object would answer `toString` with
`Object.prototype.toString`, and every such registry in the world would have that
component.

The registry holds **no renderer**. It says *what* the host's components are; *how*
they render is the host's own table, and the host renders the tree with its own
machinery.

**Why.** The discriminator already found this defect once, in the worker's bridge: a
plain property lookup found `Object.prototype`, and the "closed set" leaked. The
registry is the same kind of set and gets the same treatment — the leak is not a
mistake to be caught in review, it is a shape to be chosen against.

A renderer in the registry would put the host's functions into the layer's data path,
and the tree is the layer's product: it must be data the host can store, send and
compare. The host keeps its components; the layer keeps their names.

### D95. The patches are the seam, and the substitution happens once

A patch is a substitution: the name the agent uses, the registry's name it stands for,
and the properties the host fills in when the spec did not say. `btn` in the spec may
become `button` in the tree.

Three laws, and each of them is a law about the seam rather than about the drawing:

- **The substitution happens once.** A patch may not chain into another patch. `btn →
  button` and `button → text` turn `btn` into `button`, not into `text`: a chain makes
  the tree depend on the *order* of the host's declarations, and a tree that depends on
  the order of a list of patches is a tree the host cannot reason about.
- **A patch may not reach outside the registry.** A patch to a name the registry does
  not have is refused, exactly as a spec naming an unknown component is.
- **The spec wins where it speaks.** A patch's properties are defaults; where the spec
  said otherwise, the spec's value stands. The patch fills the gaps, and the host's
  own component decides what to do with the property it receives.

**Why.** The patches are where the host's own vocabulary meets the agent's. Without
them the agent would have to learn the host's component names, which is a coupling
that makes every host's UI vocabulary part of the model's prompt. With them the
agent says `btn` and the host decides what that means — and the decision stays a
*declaration*, small and readable, rather than code.

The one-step rule is what keeps the patch set declarative: a set of substitutions is a
table, and a table is read, not executed.

### D96. The tree is plain data, and the transformation is pure

The tree holds ids, names, properties and children. It carries no function, no getter,
no class instance and no date: it survives a JSON round trip unchanged, which is what
lets the host store it, send it, diff it and compare it.

The transformation is a pure function of the spec, the registry and the patches. There
is no clock, no randomness and no counter, so the same spec always gives the same
tree. The order of the work is the order of the law: **everything is checked before a
single node is built**, so a refused spec never leaves a half-built tree behind.

The properties of a node follow the **component's own declaration**, not the order the
spec happened to write its keys in. Two specs that say the same thing therefore give
the same tree, byte for byte.

**Why.** A tree that changes between two renders of one spec is a tree the host cannot
diff, cannot cache and cannot replay — and the journal's whole value is that it
replays (ADR 0008 D46). The layer's output sits downstream of the journal, and it
would be a poor neighbour to be less reproducible than the log it came from.

The declared order is a small law with a large effect: it makes the tree a function of
the *content* of a spec rather than of the shape of the object that carried it.

### D97. A refusal is a value, and it names the node it is about

The layer never raises for a bad spec. `render` returns either a tree or a refusal, and
a refusal carries a **path** — `/components/2/props/colour` — and a message in words
the model can read. The same shape is used everywhere the layer says no: an unknown
component, an unknown property, a missing required property, a value that is not data,
a key the format does not declare, a parent that names nothing, a loop, a duplicated
id, a patch that reaches outside the registry.

The path is a JSON Pointer, as in the tool-parameter dialect (ADR 0004 D22): the model
that asked for the drawing is told precisely what to fix, which is the same courtesy
the dialect extends to a tool call with bad arguments.

**Why.** The core treats errors as values (ADR 0004 Q5), and a spec comes from a model
— an event, not an exception. A drawing the host does not have is an ordinary event in
a run, and the run must not die of it.

### D98. The `block` entry is a first-class event of the interface, and it is not folded into the tool result

ADR 0008's open question 3 asked whether the interface renders a denial as a
first-class event or folds it into the tool result. **First-class.** The host's
projection of the journal maps a `block` entry to a component of its own — a refusal,
beside the call it refused — and does not map the error tool result that the same
denial produced as a second refusal.

**Why.**

*The journal keeps two facts about one denial, and the interface must show one of
them.* A denial produces a `block` entry (the refusal, for the model and the audit)
*and* an error tool result that answers the call, because law M1 says every call
receives exactly one result and a denial is answered too (ADR 0008 D44). The interface
sees both. Showing both would show the user the same refusal twice; showing neither
would hide it. The interface shows the `block` entry and folds the derived result into
it — one thing on the screen, and the thing that is the refusal rather than the
answer.

*A denial and a failure are different facts, and the difference is the audit.* A tool
that failed is a fact about the tool; a call the policy refused is a fact about the
user's decision. The `block` entry exists precisely so that the audit can tell them
apart — that is why it is a separate entry kind and not a `tool_result` with a flag.
An interface that folds the refusal into the tool result undoes, in the one place the
human looks, a distinction the core made on purpose.

*The layer cannot fold it, and should not.* This layer reads no journal (D91): folding
a refusal into a tool result is a decision about how two journal entries are shown
together, and it belongs to the host's projection, not to a layer that produces trees.
What the layer owes the host is that both views are expressible as data: a refusal
drawn as a component of its own, and a refusal drawn as part of the result, are two
specs, and both are checked the same way.

*What it costs.* A host that wants a refusal on the screen needs a component for it.
A host that has none shows nothing for the `block` — the refusal is still in the
journal, still in the model's context, and still in the audit. The layer does not
require it, and it does not invent one: an invented component would be a name the
registry does not have (D94).

### The laws this layer is accountable to

- a spec that names a component the registry does not have, or a property the
  component does not declare, is **refused before the tree is built**;
- the tree is **plain data**: it survives a JSON round trip unchanged;
- the same spec always produces the **same tree**;
- the registry is a **closed set**: nothing reaches it from `Object.prototype`;
- a patch substitutes **once**, and never reaches outside the registry.

Each is a claim with a verifier and a control: `ui-spec-laws` and `ui-registry-laws`.

## Consequences

**Positive**

- An application can let the agent draw inside its own interface, with its own
  components, without giving the model any way to run code.
- The seam is small and declarative: a registry of names, a list of substitutions, and
  a tree. A host that reads the three can predict what the layer will do with any
  spec it has ever seen.
- The tree is data, so a host may store it, replay it, diff two of them, or send it to
  a peer — the same properties the journal has.

**Negative**

- The layer is not a UI framework. It draws nothing; it produces a tree, and the host
  renders it. An application that wants a layout engine, a style system or a
  component library keeps them.
- The vocabulary of the spec is closed, and a closed vocabulary is a constraint on the
  model: the model may not invent a property, and a host that wants an open one must
  declare it.
- The spec is flat, so a model that wants to express a deep tree must name parents
  rather than nest. That is more tokens and less structure — the price of a check that
  is total rather than recursive.

## Out of scope for this ADR

- **How the host renders the tree.** The layer's product is the tree; the drawing is
  the host's.
- **How the agent is asked for a spec.** The layer reads a spec from text or from a
  structured request; the prompt that makes a model write one is the host's, and so is
  the tool the host may expose.
- **The `block` entry's fate in the journal.** It stays what it is: one entry for the
  model, one answer for the call. This ADR decides only how it is *shown*.

## Open questions for the owner

1. **The size of a spec.** The layer refuses a spec it does not like, but it does not
   bound one: the host's own budget for a drawing (a component count, a nesting
   depth) is a host policy, and the layer has no opinion on it. Whether the layer
   should carry one as a default is open.
2. **The `required` properties.** A component may declare the properties it cannot do
   without, and the layer refuses a spec that leaves one out. Whether the component
   should also be able to say what a *default* is — so that a spec may omit it — is
   open; today the patch's defaults are the only place a default may live.
3. **Whether the refusal gets its own component by default.** D98 leaves the refusal
   to the host. Whether the layer should ship a conventional name for it (so that
   hosts agree) is a question of taste, and it would be a name in a registry the host
   owns.
