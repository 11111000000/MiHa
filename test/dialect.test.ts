import { describe, expect, test } from "bun:test";
import { toJsonSchema, validate, type ToolSchema } from "../src/schema/dialect.ts";

const person: ToolSchema = {
	kind: "object",
	properties: {
		name: { kind: "string" },
		age: { kind: "number", integer: true, coerce: true },
		active: { kind: "boolean" },
		tags: { kind: "array", items: { kind: "string" } },
		address: {
			kind: "object",
			properties: { city: { kind: "string" } },
			required: ["city"],
		},
	},
	required: ["name"],
	additional: false,
};

describe("dialect laws", () => {
	test("C1 — accepts every value the dialect admits", () => {
		const outcome = validate(person, {
			name: "Ada",
			age: 36,
			active: true,
			tags: ["x", "y"],
			address: { city: "London" },
		});
		expect(outcome.ok).toBe(true);
	});

	test("C2 — rejects what the dialect does not admit, with a path", () => {
		const outcome = validate(person, { name: 42 });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.error.path).toBe("/name");
		expect(outcome.error.message).toContain("expected string");
	});

	test("C2 — the path reaches the offending leaf", () => {
		const outcome = validate(person, {
			name: "Ada",
			address: { city: 7 },
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.error.path).toBe("/address/city");
	});

	test("C2 — an array index is part of the path", () => {
		const outcome = validate(person, {
			name: "Ada",
			tags: ["ok", 5],
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.error.path).toBe("/tags/1");
	});

	test("C3 — coercion happens only where the dialect says so", () => {
		const strict = validate({ kind: "number" }, "42");
		expect(strict.ok).toBe(false);

		const coerced = validate({ kind: "number", coerce: true }, "42");
		expect(coerced.ok).toBe(true);
		if (!coerced.ok) throw new Error("unreachable");
		expect(coerced.value).toBe(42);
	});

	test("C3 — the coerced value is the one the caller gets", () => {
		const outcome = validate({ kind: "number", coerce: true }, " 7 ");
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("unreachable");
		expect(outcome.value).toBe(7);
	});

	test("C2 — coercion does not rescue a value the dialect forbids", () => {
		const outcome = validate({ kind: "number", coerce: true, integer: true }, "4.5");
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.error.message).toContain("expected integer");
	});
});

describe("object semantics", () => {
	test("a missing required property is reported at its path", () => {
		const outcome = validate({ kind: "object", properties: { a: { kind: "string" } }, required: ["a"] }, {});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.error.path).toBe("/a");
	});

	test("additional: false rejects an unknown property", () => {
		const outcome = validate(
			{ kind: "object", properties: { a: { kind: "string" } }, additional: false },
			{ a: "x", b: "y" },
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.error.path).toBe("/b");
	});

	test("an additional schema validates the extra property", () => {
		const outcome = validate(
			{ kind: "object", properties: { a: { kind: "string" } }, additional: { kind: "number" } },
			{ a: "x", b: 3 },
		);
		expect(outcome.ok).toBe(true);
	});

	test("an unmentioned property passes through by default", () => {
		const outcome = validate({ kind: "object", properties: {} }, { anything: true });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("unreachable");
		expect(outcome.value).toEqual({ anything: true });
	});

	test("an array is not an object", () => {
		const outcome = validate({ kind: "object", properties: {} }, []);
		expect(outcome.ok).toBe(false);
	});
});

describe("json schema conversion", () => {
	test("the dialect converts to the subset every provider accepts", () => {
		expect(toJsonSchema(person)).toEqual({
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "integer" },
				active: { type: "boolean" },
				tags: { type: "array", items: { type: "string" } },
				address: {
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
				},
			},
			required: ["name"],
			additionalProperties: false,
		});
	});

	test("an enum becomes a json schema enum", () => {
		expect(toJsonSchema({ kind: "string", enum: ["a", "b"] })).toEqual({
			type: "string",
			enum: ["a", "b"],
		});
	});

	test("a description is carried over", () => {
		expect(toJsonSchema({ kind: "string", description: "the name" })).toEqual({
			type: "string",
			description: "the name",
		});
	});
});
