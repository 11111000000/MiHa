import { describe, expect, test } from "bun:test";
import {
	failureResult,
	planDispatch,
	successResult,
	toolRegistry,
	type ToolDefinition,
} from "../src/core/tools.ts";
import { toolCall, type ToolCallBlock, type ToolResultMessage } from "../src/core/messages.ts";

const readFile: ToolDefinition = {
	name: "read_file",
	description: "reads a file",
	parameters: {
		kind: "object",
		properties: { path: { kind: "string" } },
		required: ["path"],
		additional: false,
	},
	execute: async () => ({ content: [{ type: "text", text: "contents" }] }),
};

const listDir: ToolDefinition = {
	name: "list_dir",
	description: "lists a directory",
	parameters: { kind: "object", properties: {} },
	concurrency: "exclusive",
	execute: async () => ({ content: [{ type: "text", text: "entries" }] }),
};

const registry = toolRegistry([readFile, listDir]);

function call(id: string, name: string, args: unknown): ToolCallBlock {
	return toolCall(id, name, typeof args === "string" ? args : JSON.stringify(args));
}

function described(plan: ReturnType<typeof planDispatch>): string {
	return plan.groups.map((group) => group.map((entry) => entry.call.id).join("+")).join(" | ");
}

/** The one rejection of a plan, or a failure that says so. */
function onlyRejection(plan: ReturnType<typeof planDispatch>): ToolResultMessage {
	const [rejection] = plan.rejections;
	if (!rejection) throw new Error("expected exactly one rejection");
	return rejection;
}

describe("law M1 — every call receives exactly one result", () => {
	test("a call is either planned or rejected, never both and never neither", () => {
		const calls = [
			call("1", "read_file", { path: "a" }),
			call("2", "nosuch", {}),
			call("3", "read_file", { path: "b" }),
		];
		const plan = planDispatch(calls, registry, 1);

		const planned = plan.groups.flat().map((entry) => entry.call.id);
		const rejected = plan.rejections.map((result) => result.toolCallId);

		expect([...planned, ...rejected].sort()).toEqual(["1", "2", "3"]);
		expect(new Set([...planned, ...rejected]).size).toBe(3);
	});

	test("a rejection is a result the model can read", () => {
		const plan = planDispatch([call("1", "nosuch", {})], registry, 1);
		const rejection = onlyRejection(plan);
		expect(rejection.isError).toBe(true);
		expect(rejection.content[0]).toEqual({ type: "text", text: 'unknown tool "nosuch"' });
	});

	test("an invalid argument names the path that is wrong", () => {
		const plan = planDispatch([call("1", "read_file", { path: 7 })], registry, 1);
		const rejection = onlyRejection(plan);
		expect(rejection.isError).toBe(true);
		expect(rejection.content[0]).toEqual({ type: "text", text: "/path: expected string, got number" });
	});
});

describe("law M2 — a call whose arguments did not arrive complete never runs", () => {
	test("a truncated argument string is rejected, not executed", () => {
		const truncated = '{"path": "src/comp';
		const plan = planDispatch([call("1", "read_file", truncated)], registry, 1);

		expect(plan.groups).toHaveLength(0);
		expect(plan.rejections).toHaveLength(1);
		expect(onlyRejection(plan).content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("not valid JSON"),
		});
	});

	test("a truncated string that happens to be valid JSON is still rejected by the schema", () => {
		// The provider may have salvaged the fragment into something that parses.
		// The schema catches it, so the call never reaches the tool.
		const salvaged = '{"path": "a"';
		const plan = planDispatch([call("1", "read_file", salvaged)], registry, 1);
		expect(plan.groups).toHaveLength(0);
		expect(plan.rejections).toHaveLength(1);
	});

	test("an empty argument string is rejected", () => {
		const plan = planDispatch([call("1", "read_file", "")], registry, 1);
		expect(plan.groups).toHaveLength(0);
		expect(plan.rejections).toHaveLength(1);
	});

	test("the raw text survives in the transcript, whatever happened to it", () => {
		const truncated = '{"path": "src/comp';
		const plan = planDispatch([call("1", "read_file", truncated)], registry, 1);
		expect(onlyRejection(plan).toolCallId).toBe("1");
		// the call itself is the provider's, and its text was never rewritten
		expect(call("1", "read_file", truncated).argumentsText).toBe(truncated);
	});
});

describe("law M3 — a failed tool is a result, not ordinary content", () => {
	test("a throw becomes an error result", () => {
		const thrown = failureResult(call("1", "read_file", {}), new Error("no such file"));
		expect(thrown.isError).toBe(true);
		expect(thrown.content[0]).toEqual({ type: "text", text: "no such file" });
	});

	test("an error result keeps the details a throw would have discarded", () => {
		const ok = successResult(call("1", "read_file", {}), {
			content: [{ type: "text", text: "partial" }],
			details: { lines: 12 },
			isError: true,
		});
		expect(ok.isError).toBe(true);
		expect(ok.details).toEqual({ lines: 12 });
	});
});

describe("policy T1 — grouping", () => {
	test("exclusive tools run alone, shared ones around them still run together", () => {
		const plan = planDispatch(
			[
				call("1", "read_file", { path: "a" }),
				call("2", "read_file", { path: "b" }),
				call("3", "list_dir", {}),
				call("4", "read_file", { path: "c" }),
			],
			registry,
			1,
		);
		expect(described(plan)).toBe("1+2 | 3 | 4");
	});

	test("two exclusive tools never share a group", () => {
		const plan = planDispatch(
			[call("1", "list_dir", {}), call("2", "list_dir", {})],
			registry,
			1,
		);
		expect(described(plan)).toBe("1 | 2");
	});

	test("the order of the calls is preserved by the groups", () => {
		const plan = planDispatch(
			[
				call("1", "list_dir", {}),
				call("2", "read_file", { path: "a" }),
				call("3", "list_dir", {}),
			],
			registry,
			1,
		);
		expect(described(plan)).toBe("1 | 2 | 3");
	});

	test("a rejected call does not break a group", () => {
		const plan = planDispatch(
			[
				call("1", "read_file", { path: "a" }),
				call("2", "nosuch", {}),
				call("3", "read_file", { path: "b" }),
			],
			registry,
			1,
		);
		expect(described(plan)).toBe("1+3");
		expect(plan.rejections).toHaveLength(1);
	});
});

describe("the registry", () => {
	test("two tools with the same name are refused", () => {
		expect(() => toolRegistry([readFile, { ...readFile }])).toThrow("duplicate tool name");
	});

	test("the coercion of the dialect reaches the tool", () => {
		const coerced = toolRegistry([
			{
				name: "count",
				description: "counts",
				parameters: { kind: "object", properties: { n: { kind: "number", coerce: true } } },
				execute: async () => ({ content: [] }),
			},
		]);
		const plan = planDispatch([call("1", "count", { n: "42" })], coerced, 1);
		expect(plan.groups[0]?.[0]?.args).toEqual({ n: 42 });
	});
});
