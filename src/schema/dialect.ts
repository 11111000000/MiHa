/**
 * The tool-parameter schema dialect.
 *
 * This is **our own** language, not a subset of JSON Schema. The difference matters:
 * a subset validator rejects schemas it happens not to support, and that is a
 * permanent liability. A dialect that we implement completely accepts everything the
 * dialect admits and rejects only what it does not.
 *
 * Seven kinds, each fully specified. Coercion is explicit per node — `"42"` becomes
 * `42` only where the node says so.
 *
 * Errors carry a JSON Pointer (RFC 6901) to the offending node, so the model can be
 * told precisely what to fix:
 *
 *     { path: "/items/0/count", message: "expected number, got string" }
 *
 * Laws:
 *
 *   C1  the validator accepts every value the dialect admits
 *   C2  the validator rejects every value the dialect does not admit, with a path
 *   C3  coercion happens only where the dialect says so
 */

import { assertNever } from "../core/exhaustive.ts";

export interface SchemaMeta {
	readonly description?: string;
}

export interface ObjectSchema extends SchemaMeta {
	readonly kind: "object";
	readonly properties: Readonly<Record<string, ToolSchema>>;
	readonly required?: readonly string[];
	/**
	 * What happens to a property the schema does not name.
	 * `false` rejects it, a schema validates it, `undefined` allows it through.
	 */
	readonly additional?: boolean | ToolSchema;
}

export interface ArraySchema extends SchemaMeta {
	readonly kind: "array";
	readonly items: ToolSchema;
}

export interface StringSchema extends SchemaMeta {
	readonly kind: "string";
	readonly enum?: readonly string[];
	readonly coerce?: boolean;
}

export interface NumberSchema extends SchemaMeta {
	readonly kind: "number";
	readonly integer?: boolean;
	readonly coerce?: boolean;
}

export interface BooleanSchema extends SchemaMeta {
	readonly kind: "boolean";
	readonly coerce?: boolean;
}

export interface NullSchema extends SchemaMeta {
	readonly kind: "null";
}

export interface AnySchema extends SchemaMeta {
	readonly kind: "any";
}

export type ToolSchema =
	| ObjectSchema
	| ArraySchema
	| StringSchema
	| NumberSchema
	| BooleanSchema
	| NullSchema
	| AnySchema;

export interface SchemaError {
	/** JSON Pointer to the offending node; the empty string is the root. */
	readonly path: string;
	readonly message: string;
}

export type ValidationResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: SchemaError };

const ok = (value: unknown): ValidationResult => ({ ok: true, value });
const fail = (path: string, message: string): ValidationResult => ({
	ok: false,
	error: { path, message },
});

/** Escapes one JSON Pointer segment (RFC 6901). */
export function pointerSegment(segment: string): string {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function child(path: string, segment: string | number): string {
	return `${path}/${pointerSegment(String(segment))}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The name of a value's type, as it is reported to a model.
 *
 * Numbers are reported as "number" whatever they are. Telling a model it sent an
 * "integer" when it sent `7` is noise: in the dialect, `integer` is a refinement of
 * `number`, not a different kind of thing. Where the distinction matters — an integer
 * that is not one — the message carries the value instead.
 */
function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * Validates a value against the dialect.
 *
 * The returned value is the coerced value: where a node coerces, the result carries
 * the converted form, and the caller must use it rather than the input.
 */
export function validate(schema: ToolSchema, value: unknown): ValidationResult {
	return validateAt(schema, value, "");
}

function validateAt(schema: ToolSchema, value: unknown, path: string): ValidationResult {
	switch (schema.kind) {
		case "object":
			return validateObject(schema, value, path);
		case "array":
			return validateArray(schema, value, path);
		case "string":
			return validateString(schema, value, path);
		case "number":
			return validateNumber(schema, value, path);
		case "boolean":
			return validateBoolean(schema, value, path);
		case "null":
			return value === null ? ok(value) : fail(path, `expected null, got ${typeName(value)}`);
		case "any":
			return ok(value);
		default:
			return assertNever(schema, "validateAt");
	}
}

function validateObject(
	schema: ObjectSchema,
	value: unknown,
	path: string,
): ValidationResult {
	if (!isPlainObject(value)) {
		return fail(path, `expected object, got ${typeName(value)}`);
	}

	const required = schema.required ?? [];
	for (const name of required) {
		if (!Object.prototype.hasOwnProperty.call(value, name)) {
			return fail(child(path, name), "required property is missing");
		}
	}

	const result: Record<string, unknown> = {};
	for (const [name, propertySchema] of Object.entries(schema.properties)) {
		if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
		const outcome = validateAt(propertySchema, value[name], child(path, name));
		if (!outcome.ok) return outcome;
		result[name] = outcome.value;
	}

	for (const [name, extra] of Object.entries(value)) {
		if (Object.prototype.hasOwnProperty.call(schema.properties, name)) continue;
		if (schema.additional === false) {
			return fail(child(path, name), "property is not allowed");
		}
		if (schema.additional === undefined) {
			result[name] = extra;
			continue;
		}
		const outcome = validateAt(schema.additional, extra, child(path, name));
		if (!outcome.ok) return outcome;
		result[name] = outcome.value;
	}

	return ok(result);
}

function validateArray(schema: ArraySchema, value: unknown, path: string): ValidationResult {
	if (!Array.isArray(value)) {
		return fail(path, `expected array, got ${typeName(value)}`);
	}
	const result: unknown[] = [];
	for (const [index, item] of value.entries()) {
		const outcome = validateAt(schema.items, item, child(path, index));
		if (!outcome.ok) return outcome;
		result.push(outcome.value);
	}
	return ok(result);
}

function validateString(
	schema: StringSchema,
	value: unknown,
	path: string,
): ValidationResult {
	let candidate: string;
	if (typeof value === "string") {
		candidate = value;
	} else if (schema.coerce && (typeof value === "number" || typeof value === "boolean")) {
		candidate = String(value);
	} else {
		return fail(path, `expected string, got ${typeName(value)}`);
	}
	if (schema.enum && !schema.enum.includes(candidate)) {
		return fail(path, `expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(candidate)}`);
	}
	return ok(candidate);
}

function validateNumber(
	schema: NumberSchema,
	value: unknown,
	path: string,
): ValidationResult {
	let candidate: number;
	if (typeof value === "number") {
		candidate = value;
	} else if (schema.coerce && typeof value === "string") {
		const parsed = Number(value.trim());
		if (value.trim() === "" || !Number.isFinite(parsed)) {
			return fail(path, `expected number, got string ${JSON.stringify(value)}`);
		}
		candidate = parsed;
	} else {
		return fail(path, `expected number, got ${typeName(value)}`);
	}
	if (!Number.isFinite(candidate)) {
		return fail(path, "expected a finite number");
	}
	if (schema.integer && !Number.isInteger(candidate)) {
		return fail(path, `expected integer, got ${candidate}`);
	}
	return ok(candidate);
}

function validateBoolean(
	schema: BooleanSchema,
	value: unknown,
	path: string,
): ValidationResult {
	if (typeof value === "boolean") return ok(value);
	if (schema.coerce && typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return ok(true);
		if (normalized === "false") return ok(false);
	}
	return fail(path, `expected boolean, got ${typeName(value)}`);
}

/**
 * The JSON Schema (draft-07 subset) a provider receives.
 *
 * Every provider accepts this subset, and MiHa produces it from the dialect rather
 * than asking the host to write JSON Schema by hand.
 */
export interface JsonSchema {
	readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly items?: JsonSchema;
	readonly additionalProperties?: boolean | JsonSchema;
	readonly enum?: readonly unknown[];
	readonly description?: string;
}

export function toJsonSchema(schema: ToolSchema): JsonSchema {
	switch (schema.kind) {
		case "object": {
			const properties: Record<string, JsonSchema> = {};
			for (const [name, propertySchema] of Object.entries(schema.properties)) {
				properties[name] = toJsonSchema(propertySchema);
			}
			const base: JsonSchema = {
				type: "object",
				properties,
				...(schema.required && schema.required.length > 0 ? { required: schema.required } : {}),
				...(schema.description === undefined ? {} : { description: schema.description }),
			};
			if (schema.additional === undefined) return base;
			return {
				...base,
				additionalProperties:
					schema.additional === true ? true : schema.additional === false ? false : toJsonSchema(schema.additional),
			};
		}
		case "array":
			return {
				type: "array",
				items: toJsonSchema(schema.items),
				...(schema.description === undefined ? {} : { description: schema.description }),
			};
		case "string":
			return {
				type: "string",
				...(schema.enum ? { enum: schema.enum } : {}),
				...(schema.description === undefined ? {} : { description: schema.description }),
			};
		case "number":
			return {
				type: schema.integer ? "integer" : "number",
				...(schema.description === undefined ? {} : { description: schema.description }),
			};
		case "boolean":
			return {
				type: "boolean",
				...(schema.description === undefined ? {} : { description: schema.description }),
			};
		case "null":
			return {
				type: "null",
				...(schema.description === undefined ? {} : { description: schema.description }),
			};
		case "any":
			return schema.description === undefined ? {} : { description: schema.description };
		default:
			return assertNever(schema, "toJsonSchema");
	}
}
