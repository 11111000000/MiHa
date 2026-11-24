/**
 * The component registry and the patches: the host's declaration of its interface.
 *
 * The registry is the **closed set**: the names the host's interface is made of and
 * the properties each of them accepts. A spec that names anything else is refused,
 * and so is a spec that carries a property the component does not declare — the set
 * is closed in both directions.
 *
 * The registry holds no renderer. It says *what* the host's components are; *how*
 * they render is the host's own table, and a renderer kept here would put the
 * host's functions into the layer's data path. The layer's product is a tree of
 * names and values, and the host renders that tree with its own machinery.
 *
 * The **patches** are the seam where the host's own components are substituted. The
 * agent says `btn`, the host's registry says `button`, and the patch says that
 * `btn` means `button` here. A patch is small and declarative: a substitution, and
 * the properties the host fills in when the spec did not say. The substitution
 * happens once — a patch may not chain into another patch — and it may not reach
 * outside the registry.
 */

/** One component of the host's interface. */
export interface ComponentDefinition {
	/** The name a spec uses to ask for this component. */
	readonly name: string;
	/** The properties the component accepts. Every other property is refused. */
	readonly properties: readonly string[];
	/** The properties the component cannot do without. */
	readonly required?: readonly string[];
}

/**
 * The registry: a map of names to components.
 *
 * A map and not an object, because an object lookup finds `Object.prototype`:
 * `toString` would be a component of every registry in the world.
 */
export interface ComponentRegistry {
	readonly definitions: ReadonlyMap<string, ComponentDefinition>;
}

/** A substitution: the name the agent uses, and the host's own component. */
export interface Patch {
	/** The name the spec uses. */
	readonly from: string;
	/** The registry's name it stands for. */
	readonly to: string;
	/** The properties the host fills in when the spec did not say. */
	readonly defaults?: Readonly<Record<string, unknown>>;
}

/** The patches, as a lookup. */
export interface PatchSet {
	readonly patches: ReadonlyMap<string, Patch>;
}

/**
 * Builds a registry, refusing two components with the same name.
 *
 * The declaration is the host's own, so a broken one is a mistake of the host's
 * programmer and is raised at once — the same way the tool registry is.
 */
export function componentRegistry(definitions: readonly ComponentDefinition[]): ComponentRegistry {
	const map = new Map<string, ComponentDefinition>();
	for (const definition of definitions) {
		if (typeof definition.name !== "string" || definition.name.length === 0) {
			throw new Error("a component must have a name");
		}
		if (map.has(definition.name)) {
			throw new Error(`duplicate component name: ${definition.name}`);
		}
		const seen = new Set<string>();
		const properties: string[] = [];
		for (const property of definition.properties) {
			if (typeof property !== "string" || property.length === 0) {
				throw new Error(`a property of "${definition.name}" must have a name`);
			}
			if (seen.has(property)) {
				throw new Error(`duplicate property "${property}" of component "${definition.name}"`);
			}
			if (property === "__proto__") {
				throw new Error(`the component "${definition.name}" may not declare the property "__proto__"`);
			}
			seen.add(property);
			properties.push(property);
		}
		const required = definition.required === undefined ? undefined : [...definition.required];
		map.set(definition.name, {
			name: definition.name,
			properties,
			...(required === undefined ? {} : { required }),
		});
	}
	return { definitions: map };
}

/** The component of that name, if the registry has one. */
export function findComponent(
	registry: ComponentRegistry,
	name: string,
): ComponentDefinition | undefined {
	return registry.definitions.get(name);
}

/** Builds the patches, refusing two patches for the same name. */
export function patchSet(patches: readonly Patch[]): PatchSet {
	const map = new Map<string, Patch>();
	for (const patch of patches) {
		if (typeof patch.from !== "string" || patch.from.length === 0) {
			throw new Error("a patch must name what it substitutes");
		}
		if (typeof patch.to !== "string" || patch.to.length === 0) {
			throw new Error(`the patch from "${patch.from}" must name what it stands for`);
		}
		if (map.has(patch.from)) {
			throw new Error(`duplicate patch for "${patch.from}"`);
		}
		map.set(patch.from, patch);
	}
	return { patches: map };
}
