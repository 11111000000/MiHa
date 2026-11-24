import { describe, expect, test } from "bun:test";
import {
	SPEC_VERSION,
	componentRegistry,
	flatSpec,
	parseSpec,
	render,
	renderText,
	type ComponentRegistry,
	type FlatSpec,
	type Tree,
} from "../src/ui/index.ts";

/**
 * The interface layer: the registry, the flat spec, the patches and the tree.
 *
 * The layer exists for one reason: an application embeds MiHa and the agent may
 * *draw*. What the agent sends is a **spec**, and a spec is **data**. A spec that
 * carries code would be code running in the user's page, which is exactly what the
 * permission seam exists to prevent (ADR 0008 D44).
 *
 * What the tests pin down:
 *
 *   - a spec that names a component the registry does not have is refused, and so
 *     is a spec that carries a property the component does not declare
 *   - the refusal comes before any tree exists
 *   - the tree is plain data: it survives a JSON round trip and carries no
 *     function, no getter, no date and no class instance
 *   - the same spec rendered twice gives the same tree
 *   - the tree nests the components under their parents
 */

/** The host's interface: four components and the properties each of them accepts. */
const registry: ComponentRegistry = componentRegistry([
	{ name: "page", properties: ["title"] },
	{ name: "panel", properties: ["heading", "tone"] },
	{ name: "button", properties: ["label", "kind"], required: ["label"] },
	{ name: "text", properties: ["value"] },
]);

/** A spec that draws a page, a panel in it and a button in the panel. */
const spec: FlatSpec = flatSpec([
	{ id: "root", name: "page", props: { title: "Report" } },
	{ id: "card", name: "panel", props: { heading: "Totals", tone: "quiet" }, parent: "root" },
	{ id: "go", name: "button", props: { label: "Go" }, parent: "card" },
]);

function treeOf(drawn: FlatSpec): Tree {
	const result = render(drawn, registry);
	if (!result.ok) throw new Error(`expected a tree, got a refusal: ${result.error.message}`);
	return result.tree;
}

/**
 * Walks a value and refuses anything that is not data.
 *
 * Written here rather than imported: the layer's own check must not be the thing
 * that proves the layer's own check.
 */
function onlyData(value: unknown, path: string): void {
	if (value === null) return;
	const type = typeof value;
	if (type === "string" || type === "number" || type === "boolean") return;
	if (type !== "object") throw new Error(`the tree carries a ${type} at ${path}`);
	if (Array.isArray(value)) {
		value.forEach((item, index) => onlyData(item, `${path}/${index}`));
		return;
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`the tree carries a class instance at ${path}`);
	}
	const entries: [string, unknown][] = Object.entries(value as Record<string, unknown>);
	for (const [key, item] of entries) onlyData(item, `${path}/${key}`);
}

describe("the interface layer", () => {
	test("a spec that names a component the registry does not have is refused", () => {
		const result = render(flatSpec([{ id: "a", name: "chart" }]), registry);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.path).toBe("/components/0/name");
		expect(result.error.message).toContain("chart");
	});

	test("a property the component does not declare is refused", () => {
		const result = render(
			flatSpec([{ id: "a", name: "text", props: { value: "hi", colour: "red" } }]),
			registry,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.path).toBe("/components/0/props/colour");
		expect(result.error.message).toContain("colour");
	});

	test("the refusal comes before the tree is built", () => {
		const result = render(
			flatSpec([
				{ id: "a", name: "text", props: { value: "hi" } },
				{ id: "b", name: "ghost" },
			]),
			registry,
		);
		expect(result.ok).toBe(false);
		// There is no tree to half-build: the result is the refusal and nothing else.
		expect(Object.keys(result)).toEqual(["ok", "error"]);
	});

	test("a spec naming a name of Object.prototype is refused", () => {
		const result = render(flatSpec([{ id: "a", name: "toString" }]), registry);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.path).toBe("/components/0/name");
	});

	test("the tree is plain data: it survives a JSON round trip unchanged", () => {
		const tree = treeOf(spec);
		expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
	});

	test("the tree carries nothing but data", () => {
		onlyData(treeOf(spec), "");
	});

	test("the same spec rendered twice gives the same tree", () => {
		const first = treeOf(spec);
		const second = treeOf(spec);
		expect(second).toEqual(first);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	test("the same spec, built again, gives the same tree", () => {
		const again: FlatSpec = flatSpec([
			{ id: "root", name: "page", props: { title: "Report" } },
			{ id: "card", name: "panel", props: { heading: "Totals", tone: "quiet" }, parent: "root" },
			{ id: "go", name: "button", props: { label: "Go" }, parent: "card" },
		]);
		expect(treeOf(again)).toEqual(treeOf(spec));
	});

	test("a spec that carries a function is refused, and the function is never called", () => {
		let calls = 0;
		const result = render(
			flatSpec([
				{
					id: "a",
					name: "text",
					props: {
						value: () => {
							calls += 1;
							return "x";
						},
					},
				},
			]),
			registry,
		);
		expect(result.ok).toBe(false);
		expect(calls).toBe(0);
	});

	test("a spec that carries a getter is refused, and the getter is never called", () => {
		let calls = 0;
		const props: Record<string, unknown> = {};
		Object.defineProperty(props, "value", {
			get() {
				calls += 1;
				return "x";
			},
			enumerable: true,
			configurable: true,
		});
		const result = render(flatSpec([{ id: "a", name: "text", props }]), registry);
		expect(result.ok).toBe(false);
		expect(calls).toBe(0);
	});

	test("a spec that carries a date is refused", () => {
		const result = render(
			flatSpec([{ id: "a", name: "text", props: { value: new Date(0) } }]),
			registry,
		);
		expect(result.ok).toBe(false);
	});

	test("the tree nests the components under their parent", () => {
		const tree = treeOf(spec);
		expect(tree.roots).toHaveLength(1);
		const root = tree.roots[0];
		expect(root?.name).toBe("page");
		expect(root?.props).toEqual({ title: "Report" });
		const card = root?.children[0];
		expect(card?.name).toBe("panel");
		expect(card?.props).toEqual({ heading: "Totals", tone: "quiet" });
		const button = card?.children[0];
		expect(button?.name).toBe("button");
		expect(button?.props).toEqual({ label: "Go" });
		expect(button?.children).toEqual([]);
	});

	test("a parent that names no component is refused", () => {
		const result = render(
			flatSpec([{ id: "a", name: "text", props: { value: "hi" }, parent: "ghost" }]),
			registry,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.path).toBe("/components/0/parent");
	});

	test("a parent chain that loops is refused", () => {
		const result = render(
			flatSpec([
				{ id: "a", name: "text", props: { value: "one" }, parent: "b" },
				{ id: "b", name: "text", props: { value: "two" }, parent: "a" },
			]),
			registry,
		);
		expect(result.ok).toBe(false);
	});

	test("two components with one id are refused", () => {
		const result = render(
			flatSpec([
				{ id: "a", name: "text", props: { value: "one" } },
				{ id: "a", name: "text", props: { value: "two" } },
			]),
			registry,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.path).toBe("/components/1/id");
	});

	test("the tree's properties follow the component's own declaration", () => {
		const tree = treeOf(flatSpec([{ id: "a", name: "button", props: { kind: "primary", label: "Go" } }]));
		expect(Object.keys(tree.roots[0]?.props ?? {})).toEqual(["label", "kind"]);
	});

	test("a spec of another version is refused", () => {
		const result = render({ version: SPEC_VERSION + 1, components: [] }, registry);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.path).toBe("/version");
	});

	test("an empty spec gives an empty tree", () => {
		const tree = treeOf(flatSpec([]));
		expect(tree.roots).toEqual([]);
		expect(tree.version).toBe(SPEC_VERSION);
	});

	test("a component may not carry a property the format does not declare", () => {
		const smuggled = {
			version: SPEC_VERSION,
			components: [{ id: "a", name: "text", onClick: "boom" }],
		} as unknown as FlatSpec;
		const result = render(smuggled, registry);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.path).toBe("/components/0/onClick");
	});

	test("the spec itself may not carry a property the format does not declare", () => {
		const smuggled = {
			version: SPEC_VERSION,
			components: [],
			script: "boom",
		} as unknown as FlatSpec;
		const result = render(smuggled, registry);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.path).toBe("/script");
	});

	test("text is read as a spec", () => {
		const parsed = parseSpec(
			'{"version":1,"components":[{"id":"a","name":"text","props":{"value":"hi"}}]}',
		);
		expect(parsed.ok).toBe(true);
		const result = renderText(
			'{"version":1,"components":[{"id":"a","name":"text","props":{"value":"hi"}}]}',
			registry,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected a tree");
		expect(result.tree.roots[0]?.name).toBe("text");
	});

	test("text that is not a spec is refused", () => {
		expect(renderText("not json at all", registry).ok).toBe(false);
		expect(renderText('{"version":1,"components":[{"name":"text"}]}', registry).ok).toBe(false);
		expect(renderText('{"version":1,"components":[{"id":"a","name":"ghost"}]}', registry).ok).toBe(false);
	});
});
