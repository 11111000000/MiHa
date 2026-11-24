/**
 * The flat spec: what the agent asks the host's interface to draw.
 *
 * A spec is **data**. It is a list of components, each with a name and a set of
 * properties — no expressions, no scripts, no functions. A spec that carries code
 * is code running in the user's page, which is exactly what the permission seam
 * exists to prevent (ADR 0008 D44). So the layer refuses anything it cannot write
 * down and read back: a function, a getter, a date, a class instance.
 *
 * The spec is **flat**: the components are a list, not a tree. A component says
 * which component it sits under by naming it, and the tree is built afterwards.
 * The flatness keeps the check total — every component is checked on its own, and
 * there is no recursive schema whose own rules could be wrong.
 *
 * The vocabulary of the format is **closed**. A component may carry an id, a name,
 * properties and a parent, and the spec may carry a version and its components.
 * Anything else is refused rather than ignored: a key the format does not declare
 * is a place where code could hide.
 *
 * The version is in the spec, not in the code. A spec that says another version is
 * refused rather than guessed at.
 */

import { parseJson } from "../core/json.ts";

/** The version of the spec format. A spec of another version is refused. */
export const SPEC_VERSION = 1;

/** One component the agent asks for. */
export interface SpecComponent {
	/** The component's id: what other components name as their parent. */
	readonly id: string;
	/** The component's name; the registry decides whether the host has one. */
	readonly name: string;
	/** The properties; every one of them must be declared by the component. */
	readonly props?: Readonly<Record<string, unknown>>;
	/** The id of the component this one sits under. */
	readonly parent?: string;
}

/** The agent's request: a flat list of components. */
export interface FlatSpec {
	readonly version: number;
	readonly components: readonly SpecComponent[];
}

/** A refusal: where in the spec it is, and why. */
export interface Refusal {
	/** The path of the offending node, as a JSON Pointer. */
	readonly path: string;
	/** What is wrong with it, in words the model can read. */
	readonly message: string;
}

/** A refusal, built. */
export function refusal(path: string, message: string): { readonly ok: false; readonly error: Refusal } {
	return { ok: false, error: { path, message } };
}

/** The result of reading a spec. */
export type SpecResult =
	| { readonly ok: true; readonly spec: FlatSpec }
	| { readonly ok: false; readonly error: Refusal };

/** Builds a spec of the current version. */
export function flatSpec(components: readonly SpecComponent[]): FlatSpec {
	return { version: SPEC_VERSION, components };
}

/** The keys a component may carry. The rest are refused: they are the smuggling. */
const COMPONENT_KEYS: readonly string[] = ["id", "name", "props", "parent"];

/** The keys the spec itself may carry. */
const SPEC_KEYS: readonly string[] = ["version", "components"];

/**
 * Whether a value is **data**: something the layer can write down and read back.
 *
 * A function, a symbol, a bigint, a date, a map, a class instance, `NaN` and a
 * getter are all refused. A getter is refused *without being called* — reading it
 * would run the code the spec is not allowed to carry.
 */
export function isData(value: unknown): boolean {
	try {
		return isPlainData(value);
	} catch {
		// A proxy whose trap throws is not data either.
		return false;
	}
}

/** Whether an object owns a key. The prototype chain is not consulted. */
export function hasOwn(object: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Defines an own property.
 *
 * `defineProperty` and not an assignment: the key `__proto__` would change the
 * prototype of the target, and a target that carries a prototype is not data.
 */
export function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

/** Whether a value is a plain object: no class, no prototype but the bare one. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const prototype: unknown = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

/** Whether every own property of a value is a plain value. */
function isPlainData(value: unknown): boolean {
	if (value === null) return true;
	if (typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return isDataObject(value);
	if (typeof value !== "object") return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return isDataObject(value);
}

/** Whether every own property of an object is a plain value. */
function isDataObject(value: object): boolean {
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (key === "__proto__") return false;
		if (!("value" in descriptor)) return false;
		if (!isPlainData(descriptor.value)) return false;
	}
	return true;
}

/**
 * Checks a value and normalises it into a spec.
 *
 * Nothing is trusted: the spec may have come from a model's text, from a tool's
 * validated arguments or from the host's own code, and the closed vocabulary is
 * checked the same way for all three.
 */
export function checkSpec(value: unknown): SpecResult {
	if (!isPlainObject(value)) return refusal("", "the spec must be an object");
	for (const key of Object.keys(value)) {
		if (!SPEC_KEYS.includes(key)) {
			return refusal(`/${key}`, `the spec may not carry the property "${key}"`);
		}
	}
	const rawVersion: unknown = value["version"];
	if (typeof rawVersion !== "number" || rawVersion !== SPEC_VERSION) {
		return refusal("/version", `unsupported spec version: ${String(rawVersion)}`);
	}
	const raw = value["components"];
	if (!Array.isArray(raw)) {
		return refusal("/components", "the spec must carry a list of components");
	}
	const components: readonly unknown[] = raw;
	const checked: SpecComponent[] = [];
	for (const [index, component] of components.entries()) {
		const one = checkComponent(component, index);
		if (!one.ok) return one;
		checked.push(one.component);
	}
	return { ok: true, spec: { version: SPEC_VERSION, components: checked } };
}

/** Checks one component of a spec. */
function checkComponent(
	value: unknown,
	index: number,
): { readonly ok: true; readonly component: SpecComponent } | { readonly ok: false; readonly error: Refusal } {
	const path = `/components/${index}`;
	if (!isPlainObject(value)) return refusal(path, "a component must be an object");
	for (const key of Object.keys(value)) {
		if (!COMPONENT_KEYS.includes(key)) {
			return refusal(`${path}/${key}`, `a component may not carry the property "${key}"`);
		}
	}
	const id = value["id"];
	if (typeof id !== "string" || id.length === 0) {
		return refusal(`${path}/id`, "a component must have an id");
	}
	const name = value["name"];
	if (typeof name !== "string" || name.length === 0) {
		return refusal(`${path}/name`, "a component must have a name");
	}
	const rawParent: unknown = value["parent"];
	let parent: string | undefined;
	if (typeof rawParent === "string") {
		if (rawParent.length === 0) {
			return refusal(`${path}/parent`, "a parent must be the id of a component");
		}
		parent = rawParent;
	} else if (typeof rawParent !== "undefined") {
		return refusal(`${path}/parent`, "a parent must be the id of a component");
	}
	const props = checkProps(value["props"], `${path}/props`);
	if (!props.ok) return props;
	return {
		ok: true,
		component: {
			id,
			name,
			props: props.props,
			...(parent === undefined ? {} : { parent }),
		},
	};
}

/**
 * Checks the properties of a component and copies them.
 *
 * The copy is what makes the spec safe to hold: an accessor is refused rather than
 * called, and a value that is not data never reaches the tree.
 */
function checkProps(
	value: unknown,
	path: string,
): { readonly ok: true; readonly props: Record<string, unknown> } | { readonly ok: false; readonly error: Refusal } {
	if (typeof value === "undefined") return { ok: true, props: {} };
	if (!isPlainObject(value)) return refusal(path, "the properties must be an object");
	const props: Record<string, unknown> = {};
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const key of Object.keys(descriptors)) {
		const descriptor = descriptors[key];
		if (!descriptor) continue;
		if (!("value" in descriptor)) {
			return refusal(`${path}/${key}`, "a property must be a value, not a getter");
		}
		if (!isData(descriptor.value)) {
			return refusal(`${path}/${key}`, "a property's value must be data");
		}
		defineOwn(props, key, descriptor.value);
	}
	return { ok: true, props };
}

/** Reads a spec from the text the agent wrote. */
export function parseSpec(text: string): SpecResult {
	const parsed = parseJson(text);
	if (!parsed.ok) return refusal("", `the spec is not JSON: ${parsed.error}`);
	return checkSpec(parsed.value);
}
