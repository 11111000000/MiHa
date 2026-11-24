/**
 * The tree: what the layer produces.
 *
 * The transformation is a pure function of the spec, the registry and the patches.
 * There is no clock, no randomness and no counter, so the same spec always gives
 * the same tree — a tree that changes between two renders of one spec is a tree
 * the host cannot diff, cannot cache and cannot replay.
 *
 * The order of the work is the order of the law: **check first, build afterwards**.
 * Every component is checked against the registry before a single node is built,
 * so a spec that is refused never leaves a half-built tree behind.
 *
 * The tree is plain data. It holds names, values and children, and nothing that
 * runs: no functions, no getters, no class instances. It survives a JSON round
 * trip unchanged, which is what lets the host store it, send it and compare it.
 */

import { findComponent, type ComponentDefinition, type ComponentRegistry, type PatchSet } from "./registry.ts";
import {
	checkSpec,
	defineOwn,
	hasOwn,
	isData,
	parseSpec,
	refusal,
	type FlatSpec,
	type Refusal,
	type SpecComponent,
} from "./spec.ts";

/** One node of the tree: a component, its properties and what sits under it. */
export interface TreeNode {
	/** The id the spec gave this component. */
	readonly id: string;
	/** The registry's name of the component, after the patches. */
	readonly name: string;
	/** The properties, in the order the component declares them. */
	readonly props: Readonly<Record<string, unknown>>;
	/** What sits under this component, in the order of the spec. */
	readonly children: readonly TreeNode[];
}

/**
 * The tree.
 *
 * A spec may draw several things at once, so the tree has roots rather than one
 * root: the layer does not invent a wrapper, because a wrapper would be a
 * component the registry may not have.
 */
export interface Tree {
	/** The version of the spec the tree was built from. */
	readonly version: number;
	readonly roots: readonly TreeNode[];
}

/** The result of rendering a spec. */
export type RenderResult =
	| { readonly ok: true; readonly tree: Tree }
	| { readonly ok: false; readonly error: Refusal };

/**
 * Renders a spec into a tree, or refuses it.
 *
 * The refusal is a value and not an exception: the spec comes from a model, and a
 * model that asks for a component the host does not have is an ordinary event.
 */
export function render(
	spec: FlatSpec,
	registry: ComponentRegistry,
	patches?: PatchSet,
): RenderResult {
	// The spec is checked before it is believed: its own shape first, then the
	// registry it names.
	const checked = checkSpec(spec);
	if (!checked.ok) return checked;
	const components = checked.spec.components;
	const patchMap = patches?.patches;

	// The closed set: every name is a component of the registry, and every
	// property is one the component declares.
	const prepared = new Map<string, { readonly name: string; readonly props: Record<string, unknown> }>();
	for (const [index, component] of components.entries()) {
		const patch = patchMap?.get(component.name);
		const name = patch === undefined ? component.name : patch.to;
		const definition = findComponent(registry, name);
		if (!definition) {
			return refusal(`/components/${index}/name`, `unknown component "${name}"`);
		}
		const merged = mergeProps(
			component.props,
			definition,
			patch?.defaults,
			`/components/${index}/props`,
		);
		if (!merged.ok) return merged;
		const missing = definition.required?.find((property) => !hasOwn(merged.props, property));
		if (missing !== undefined) {
			return refusal(
				`/components/${index}/props`,
				`the component "${name}" requires the property "${missing}"`,
			);
		}
		prepared.set(component.id, { name, props: merged.props });
	}

	// The structure: the ids are one to one, the parents are there, and no chain
	// loops. A loop would make the tree infinite, so it is refused, not followed.
	const index = new Map<string, number>();
	for (const [position, component] of components.entries()) {
		if (index.has(component.id)) {
			return refusal(`/components/${position}/id`, `two components share the id "${component.id}"`);
		}
		index.set(component.id, position);
	}
	for (const [position, component] of components.entries()) {
		if (component.parent !== undefined && !index.has(component.parent)) {
			return refusal(
				`/components/${position}/parent`,
				`the parent "${component.parent}" is not a component of the spec`,
			);
		}
	}
	for (const [position, component] of components.entries()) {
		const seen = new Set<string>();
		let current: SpecComponent | undefined = component;
		while (current !== undefined && current.parent !== undefined) {
			if (seen.has(current.id)) {
				return refusal(
					`/components/${position}/parent`,
					`the parent chain of "${component.id}" loops`,
				);
			}
			seen.add(current.id);
			const at = index.get(current.parent);
			current = at === undefined ? undefined : components[at];
		}
	}

	// The tree: the roots in the order of the spec, and the children in the order
	// of the spec.
	const children = new Map<string, SpecComponent[]>();
	const roots: SpecComponent[] = [];
	for (const component of components) {
		if (component.parent === undefined) {
			roots.push(component);
			continue;
		}
		const list = children.get(component.parent);
		if (list === undefined) children.set(component.parent, [component]);
		else list.push(component);
	}
	const build = (component: SpecComponent): TreeNode => {
		const own = prepared.get(component.id);
		const kids = children.get(component.id);
		return {
			id: component.id,
			name: own?.name ?? component.name,
			props: own?.props ?? {},
			children: kids === undefined ? [] : kids.map(build),
		};
	};
	return {
		ok: true,
		tree: { version: checked.spec.version, roots: roots.map(build) },
	};
}

/**
 * Renders the text the agent wrote.
 *
 * The text is read as a spec first, and the spec is refused before anything is
 * rendered — the same way a structured request is.
 */
export function renderText(
	text: string,
	registry: ComponentRegistry,
	patches?: PatchSet,
): RenderResult {
	const parsed = parseSpec(text);
	if (!parsed.ok) return parsed;
	return render(parsed.spec, registry, patches);
}

/**
 * Merges the properties of a spec with the defaults of a patch.
 *
 * The spec's own properties come first, the patch fills what the spec did not
 * say, and the result follows the component's own declaration — so two specs that
 * say the same thing give the same tree, whatever order their keys came in.
 */
function mergeProps(
	specProps: Readonly<Record<string, unknown>> | undefined,
	definition: ComponentDefinition,
	defaults: Readonly<Record<string, unknown>> | undefined,
	path: string,
): { readonly ok: true; readonly props: Record<string, unknown> } | { readonly ok: false; readonly error: Refusal } {
	const merged: Record<string, unknown> = {};
	const own = specProps;
	if (own !== undefined) {
		for (const key of Object.keys(own)) {
			if (!definition.properties.includes(key)) {
				return refusal(
					`${path}/${key}`,
					`the component "${definition.name}" does not declare the property "${key}"`,
				);
			}
			defineOwn(merged, key, own[key]);
		}
	}
	if (defaults !== undefined) {
		const descriptors = Object.getOwnPropertyDescriptors(defaults);
		for (const key of Object.keys(descriptors)) {
			const descriptor = descriptors[key];
			if (!descriptor) continue;
			if (!definition.properties.includes(key)) {
				return refusal(
					`${path}/${key}`,
					`the component "${definition.name}" does not declare the property "${key}"`,
				);
			}
			if (!("value" in descriptor)) {
				return refusal(`${path}/${key}`, "a property must be a value, not a getter");
			}
			if (!isData(descriptor.value)) {
				return refusal(`${path}/${key}`, "a property's value must be data");
			}
			// The spec wins where it speaks: the patch fills the gaps.
			if (hasOwn(merged, key)) continue;
			defineOwn(merged, key, descriptor.value);
		}
	}
	const ordered: Record<string, unknown> = {};
	for (const key of definition.properties) {
		if (hasOwn(merged, key)) defineOwn(ordered, key, merged[key]);
	}
	return { ok: true, props: ordered };
}
