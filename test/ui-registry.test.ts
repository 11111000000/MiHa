import { describe, expect, test } from "bun:test";
import {
	componentRegistry,
	findComponent,
	flatSpec,
	patchSet,
	render,
	type ComponentRegistry,
	type FlatSpec,
	type PatchSet,
	type Tree,
} from "../src/ui/index.ts";

/**
 * The registry and the patches: the host's own declaration of its interface.
 *
 * The registry is a **closed set**. A spec that names a component the registry does
 * not have is refused, and so is a spec that carries a property the component does
 * not declare — the set is closed in both directions, and nothing leaks into it
 * from the prototype chain.
 *
 * The patches are the seam where the host's own components are substituted: the
 * agent says `btn`, the host's registry says `button`, and the patch says that
 * `btn` means `button`. The substitution happens **once** — a patch may not chain
 * into another patch — and it may not reach outside the registry.
 */

const registry: ComponentRegistry = componentRegistry([
	{ name: "page", properties: ["title"] },
	{ name: "button", properties: ["label", "kind"], required: ["label"] },
	{ name: "text", properties: ["value"] },
]);

function treeOf(drawn: FlatSpec, patches?: PatchSet): Tree {
	const result = render(drawn, registry, patches);
	if (!result.ok) throw new Error(`expected a tree, got a refusal: ${result.error.message}`);
	return result.tree;
}

describe("the component registry", () => {
	test("two components with one name are refused", () => {
		expect(() =>
			componentRegistry([
				{ name: "text", properties: [] },
				{ name: "text", properties: [] },
			]),
		).toThrow();
	});

	test("a component may not declare the property __proto__", () => {
		expect(() => componentRegistry([{ name: "text", properties: ["__proto__"] }])).toThrow();
	});

	test("the closed set does not include Object.prototype", () => {
		expect(findComponent(registry, "toString")).toBeUndefined();
		expect(findComponent(registry, "constructor")).toBeUndefined();
		expect(findComponent(registry, "hasOwnProperty")).toBeUndefined();
		expect(findComponent(registry, "valueOf")).toBeUndefined();
	});

	test("a spec naming a name of Object.prototype is refused", () => {
		const result = render(flatSpec([{ id: "a", name: "toString" }]), registry);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.path).toBe("/components/0/name");
	});

	test("the registry finds a component by its own name", () => {
		expect(findComponent(registry, "text")?.name).toBe("text");
	});
});

describe("the patches", () => {
	test("a name the registry does not have is accepted only through a patch", () => {
		const aliased = flatSpec([{ id: "a", name: "btn", props: { label: "Go" } }]);
		expect(render(aliased, registry).ok).toBe(false);
		const patched = patchSet([{ from: "btn", to: "button" }]);
		const result = render(aliased, registry, patched);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected a tree");
		expect(result.tree.roots[0]?.name).toBe("button");
		expect(result.tree.roots[0]?.props).toEqual({ label: "Go" });
	});

	test("a patch is applied once", () => {
		const patched = patchSet([
			{ from: "btn", to: "button" },
			{ from: "button", to: "text" },
		]);
		const tree = treeOf(flatSpec([{ id: "a", name: "btn", props: { label: "Go" } }]), patched);
		expect(tree.roots[0]?.name).toBe("button");
	});

	test("a patch may not reach outside the registry", () => {
		const patched = patchSet([{ from: "btn", to: "ghost" }]);
		const result = render(flatSpec([{ id: "a", name: "btn" }]), registry, patched);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.message).toContain("ghost");
	});

	test("a patch's defaults fill what the spec did not say", () => {
		const patched = patchSet([{ from: "btn", to: "button", defaults: { kind: "primary" } }]);
		const tree = treeOf(flatSpec([{ id: "a", name: "btn", props: { label: "Go" } }]), patched);
		expect(tree.roots[0]?.props).toEqual({ label: "Go", kind: "primary" });
	});

	test("the spec wins where it speaks", () => {
		const patched = patchSet([{ from: "btn", to: "button", defaults: { kind: "primary" } }]);
		const tree = treeOf(
			flatSpec([{ id: "a", name: "btn", props: { label: "Go", kind: "danger" } }]),
			patched,
		);
		expect(tree.roots[0]?.props).toEqual({ label: "Go", kind: "danger" });
	});

	test("a patch may not set a property the component does not declare", () => {
		const patched = patchSet([{ from: "btn", to: "button", defaults: { colour: "red" } }]);
		const result = render(flatSpec([{ id: "a", name: "btn", props: { label: "Go" } }]), registry, patched);
		expect(result.ok).toBe(false);
	});

	test("a patch whose default is not data is refused", () => {
		const patched = patchSet([{ from: "btn", to: "button", defaults: { label: () => "Go" } }]);
		const result = render(flatSpec([{ id: "a", name: "btn", props: { label: "Go" } }]), registry, patched);
		expect(result.ok).toBe(false);
	});

	test("two patches for one name are refused", () => {
		expect(() =>
			patchSet([
				{ from: "btn", to: "button" },
				{ from: "btn", to: "text" },
			]),
		).toThrow();
	});
});

describe("the values a spec may carry", () => {
	test("a value that is not data is refused", () => {
		class Widget {}
		const values: readonly unknown[] = [
			new Date(0),
			new Map(),
			new Widget(),
			Symbol("x"),
			BigInt(1),
			Number.NaN,
			undefined,
		];
		for (const value of values) {
			const result = render(
				flatSpec([{ id: "a", name: "text", props: { value } }]),
				registry,
			);
			expect(result.ok).toBe(false);
		}
	});

	test("a required property the spec omits is refused", () => {
		const result = render(flatSpec([{ id: "a", name: "button", props: { kind: "primary" } }]), registry);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.error.message).toContain("label");
	});

	test("the tree's properties carry a clean prototype", () => {
		const tree = treeOf(flatSpec([{ id: "a", name: "text", props: { value: "hi" } }]));
		const prototype: unknown = Object.getPrototypeOf(tree.roots[0]?.props ?? {});
		expect(prototype).toBe(Object.prototype);
	});

	test("a spec that carries __proto__ is refused and pollutes nothing", () => {
		const parsed: unknown = JSON.parse(
			'{"version":1,"components":[{"id":"a","name":"text","props":{"__proto__":{"polluted":true}}}]}',
		);
		const result = render(parsed as FlatSpec, registry);
		expect(result.ok).toBe(false);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("a property value that carries __proto__ is refused", () => {
		const parsed: unknown = JSON.parse(
			'{"version":1,"components":[{"id":"a","name":"text","props":{"value":{"__proto__":{"polluted":true}}}}]}',
		);
		const result = render(parsed as FlatSpec, registry);
		expect(result.ok).toBe(false);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});
