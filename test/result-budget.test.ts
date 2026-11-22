import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import { DEFAULT_RESULT_BUDGET, DEFAULT_TURN_LIMIT, resolveTurnLimit } from "../src/core/run.ts";
import { resolveBudget, truncateToolResult } from "../src/core/budget.ts";
import type { AgentEvent, ProviderEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import type { AgentMessage, ToolResultMessage } from "../src/core/messages.ts";
import { userMessage, toolResultMessage } from "../src/core/messages.ts";

/**
 * The result budget (ADR 0006 D34, default ADR 0009 D50): the core truncates every
 * result whose text exceeds the budget — failures included — keeps the head and the
 * tail, and announces the cut with the numbers. Infinity disables.
 */

function onceTool(tool: ToolDefinition): HarnessConfig {
	return {
		model: "test-model",
		system: "you are a test",
		tools: toolRegistry([tool]),
		turnLimit: 8,
	};
}

function callProvider(): HarnessHost["callProvider"] {
	return async function* callProvider(_request: ProviderRequest) {
		yield { type: "tool_call_start", id: "c1", name: "big" } as ProviderEvent;
		yield { type: "tool_arguments_delta", id: "c1", delta: "{}" } as ProviderEvent;
		yield {
			type: "done",
			stopReason: "toolUse",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		} as ProviderEvent;
	};
}

/** A tool returning `bytes` bytes of distinct text. */
function bigTool(bytes: number, isError = false): ToolDefinition {
	return {
		name: "big",
		description: "returns a lot",
		parameters: { kind: "object", properties: {} },
		execute: async () => ({
			content: [{ type: "text", text: "x".repeat(bytes) }],
			isError,
		}),
	};
}

async function recordedResult(config: HarnessConfig): Promise<readonly ToolResultMessage[]> {
	const run = runAgent(config, { callProvider: callProvider() }, { message: userMessage("go") });
	const events: AgentEvent[] = [];
	for await (const event of run) events.push(event);
	await run.result();
	const end = events.find((event) => event.type === "agent_end");
	if (!end) throw new Error("no agent_end");
	return (end.messages as readonly AgentMessage[]).filter(
		(message) => message.role === "toolResult",
	) as readonly ToolResultMessage[];
}

function resultsOf(events: readonly AgentEvent[]): readonly ToolResultMessage[] {
	const end = events.find((event) => event.type === "agent_end");
	if (!end) throw new Error("no agent_end");
	return (end.messages as readonly AgentMessage[]).filter(
		(message) => message.role === "toolResult",
	) as readonly ToolResultMessage[];
}

function textOf(result: ToolResultMessage): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("the result budget", () => {
	test("an over-budget result keeps head and tail and announces the numbers", async () => {
		const result = (await recordedResult(onceTool(bigTool(20_000))))[0];
		expect(result).toBeDefined();
		if (!result) throw new Error("no tool result");
		const text = textOf(result);
		// head and tail are the halves of the default budget
		expect(text.startsWith("x".repeat(4096))).toBe(true);
		expect(text.endsWith("x".repeat(4096))).toBe(true);
		// the middle is gone
		expect(text.length).toBeLessThan(20_000);
		// the announcement names the numbers
		expect(text).toContain(`[result truncated: ${20_000 - 8192} of 20000 bytes omitted]`);
	});

	test("a failure result is budgeted like any other", async () => {
		const result = (await recordedResult(onceTool(bigTool(20_000, true))))[0];
		if (!result) throw new Error("no tool result");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(`[result truncated: ${20_000 - 8192} of 20000 bytes omitted]`);
	});

	test("an under-budget result passes verbatim", async () => {
		const result = (await recordedResult(onceTool(bigTool(100))))[0];
		if (!result) throw new Error("no tool result");
		expect(textOf(result)).toBe("x".repeat(100));
		expect(result.content).toHaveLength(1);
	});

	test("the host's own budget is heard", async () => {
		const result = (await recordedResult({ ...onceTool(bigTool(1_000)), resultBudget: 200 }))[0];
		if (!result) throw new Error("no tool result");
		const text = textOf(result);
		expect(text).toContain(`[result truncated: ${1_000 - 200} of 1000 bytes omitted]`);
		expect(text.startsWith("x".repeat(100))).toBe(true);
		expect(text.endsWith("x".repeat(100))).toBe(true);
	});

	test("Infinity disables the budget", async () => {
		const result = (
			await recordedResult({ ...onceTool(bigTool(20_000)), resultBudget: Number.POSITIVE_INFINITY })
		)[0];
		if (!result) throw new Error("no tool result");
		expect(textOf(result)).toBe("x".repeat(20_000));
	});

	test("the default is 8192", () => {
		expect(DEFAULT_RESULT_BUDGET).toBe(8192);
	});
	test("a synthetic answer is budgeted too", async () => {
		const provider: HarnessHost["callProvider"] = async function* () {
			yield { type: "tool_call_start", id: "c1", name: "big" } as ProviderEvent;
			yield { type: "tool_arguments_delta", id: "c1", delta: "{}" } as ProviderEvent;
			yield { type: "error", message: "E".repeat(20_000) } as ProviderEvent;
		};
		const run = runAgent({ ...onceTool(bigTool(10)), turnLimit: 4 }, { callProvider: provider }, {
			message: userMessage("go"),
		});
		const events: AgentEvent[] = [];
		for await (const event of run) events.push(event);
		await run.result();
		const result = resultsOf(events)[0];
		expect(result).toBeDefined();
		if (!result) throw new Error("no tool result");
		expect(textOf(result).length).toBeLessThan(20_000);
		expect(textOf(result)).toContain("[result truncated:");
	});

	test("the head and the tail are halves of the budget", async () => {
		const result = (await recordedResult(onceTool(bigTool(20_000))))[0];
		if (!result) throw new Error("no tool result");
		const blocks = result.content.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		);
		expect(blocks[0]?.text.length).toBe(4096);
		expect(blocks[2]?.text.length).toBe(4096);
	});

	test("the head and the tail are told apart", async () => {
		const marked: ToolDefinition = {
			name: "big",
			description: "d",
			parameters: { kind: "object", properties: {} },
			execute: async () => ({
				content: [{ type: "text", text: `H${"x".repeat(19_998)}T` }],
			}),
		};
		const result = (await recordedResult(onceTool(marked)))[0];
		if (!result) throw new Error("no tool result");
		const text = textOf(result);
		expect(text.startsWith("H")).toBe(true);
		expect(text.endsWith("T")).toBe(true);
	});

	test("the cut never splits a codepoint", async () => {
		const utf8: ToolDefinition = {
			name: "big",
			description: "d",
			parameters: { kind: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "€".repeat(10_000) }] }),
		};
		const result = (await recordedResult(onceTool(utf8)))[0];
		if (!result) throw new Error("no tool result");
		expect(textOf(result)).not.toContain("\uFFFD");
	});

	test("the truncation keeps the details", async () => {
		const withDetails: ToolDefinition = {
			name: "big",
			description: "d",
			parameters: { kind: "object", properties: {} },
			execute: async () => ({
				content: [{ type: "text", text: "x".repeat(20_000) }],
				details: { note: "kept" },
			}),
		};
		const result = (await recordedResult(onceTool(withDetails)))[0];
		if (!result) throw new Error("no tool result");
		expect(result.details).toEqual({ note: "kept" });
	});

	test("a result of several text blocks is budgeted as one", async () => {
		const multi: ToolDefinition = {
			name: "big",
			description: "d",
			parameters: { kind: "object", properties: {} },
			execute: async () => ({
				content: [
					{ type: "text", text: "A".repeat(5000) },
					{ type: "text", text: "B".repeat(5000) },
				],
			}),
		};
		const result = (await recordedResult(onceTool(multi)))[0];
		if (!result) throw new Error("no tool result");
		expect(textOf(result)).toContain("[result truncated: 1809 of 10001 bytes omitted]");
	});

	test("every result of a batch is budgeted", async () => {
		const provider: HarnessHost["callProvider"] = async function* () {
			yield { type: "tool_call_start", id: "c1", name: "big" } as ProviderEvent;
			yield { type: "tool_call_start", id: "c2", name: "big" } as ProviderEvent;
			yield { type: "tool_arguments_delta", id: "c1", delta: "{}" } as ProviderEvent;
			yield { type: "tool_arguments_delta", id: "c2", delta: "{}" } as ProviderEvent;
			yield {
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			} as ProviderEvent;
		};
		const run = runAgent({ ...onceTool(bigTool(20_000)), turnLimit: 1 }, { callProvider: provider }, {
			message: userMessage("go"),
		});
		const events: AgentEvent[] = [];
		for await (const event of run) events.push(event);
		await run.result();
		const results = resultsOf(events);
		expect(results).toHaveLength(2);
		for (const result of results) expect(textOf(result)).toContain("[result truncated:");
	});

	test("the event's copy of the result is budgeted too", async () => {
		const run = runAgent(onceTool(bigTool(20_000)), { callProvider: callProvider() }, {
			message: userMessage("go"),
		});
		const events: AgentEvent[] = [];
		for await (const event of run) events.push(event);
		await run.result();
		const end = events.find((event) => event.type === "tool_execution_end");
		if (!end) throw new Error("no tool_execution_end");
		const text = end.result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).toContain("[result truncated:");
	});

	test("a budget of zero keeps nothing but the announcement", async () => {
		const result = (
			await recordedResult({ ...onceTool(bigTool(20_000)), resultBudget: 0 })
		)[0];
		if (!result) throw new Error("no tool result");
		expect(textOf(result)).toBe("[result truncated: 20000 of 20000 bytes omitted]");
	});

	test("a nonsense budget is the default, not an unbounded result", async () => {
		const result = (
			await recordedResult({ ...onceTool(bigTool(20_000)), resultBudget: Number.NaN })
		)[0];
		if (!result) throw new Error("no tool result");
		expect(textOf(result)).toContain("[result truncated:");
	});
	test("the announcement names the bytes actually dropped", async () => {
		const utf8: ToolDefinition = {
			name: "big",
			description: "d",
			parameters: { kind: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "€".repeat(10_000) }] }),
		};
		const result = (await recordedResult(onceTool(utf8)))[0];
		if (!result) throw new Error("no tool result");
		const blocks = result.content.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		);
		const enc = new TextEncoder();
		const kept = enc.encode(blocks[0]?.text ?? "").length + enc.encode(blocks[2]?.text ?? "").length;
		const total = enc.encode("€".repeat(10_000)).length;
		expect(textOf(result)).toContain(`[result truncated: ${total - kept} of ${total} bytes omitted]`);
	});

	test("the kept text fits the budget in bytes", async () => {
		const utf8: ToolDefinition = {
			name: "big",
			description: "d",
			parameters: { kind: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "€".repeat(10_000) }] }),
		};
		const result = (await recordedResult(onceTool(utf8)))[0];
		if (!result) throw new Error("no tool result");
		const blocks = result.content.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		);
		const enc = new TextEncoder();
		const kept = enc.encode(blocks[0]?.text ?? "").length + enc.encode(blocks[2]?.text ?? "").length;
		expect(kept).toBeLessThanOrEqual(8192);
	});

	test("a negative budget is the default, not nothing", async () => {
		const result = (await recordedResult({ ...onceTool(bigTool(20_000)), resultBudget: -5 }))[0];
		if (!result) throw new Error("no tool result");
		expect(textOf(result)).toContain(`[result truncated: ${20_000 - 8192} of 20000 bytes omitted]`);
	});

	test("the budget resolver hears nonsense as the default", () => {
		expect(resolveBudget(undefined)).toBe(DEFAULT_RESULT_BUDGET);
		expect(resolveBudget(Number.NaN)).toBe(DEFAULT_RESULT_BUDGET);
		expect(resolveBudget(-5)).toBe(DEFAULT_RESULT_BUDGET);
		expect(resolveBudget(0)).toBe(0);
		expect(resolveBudget(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
	});

	test("the truncator refuses a nonsense budget", () => {
		const result = toolResultMessage("c1", "big", [{ type: "text", text: "x".repeat(20_000) }], false);
		expect(textOf(truncateToolResult(result, -5))).toContain(
			`[result truncated: ${20_000 - 8192} of 20000 bytes omitted]`,
		);
	});

	test("the turn limit resolver hears nonsense as the default", () => {
		expect(resolveTurnLimit(undefined)).toBe(DEFAULT_TURN_LIMIT);
		expect(resolveTurnLimit(Number.NaN)).toBe(DEFAULT_TURN_LIMIT);
		expect(resolveTurnLimit(-1)).toBe(DEFAULT_TURN_LIMIT);
		expect(resolveTurnLimit(0)).toBe(0);
	});

	test("a rejection is budgeted like any other", async () => {
		const provider: HarnessHost["callProvider"] = async function* () {
			yield { type: "tool_call_start", id: "c1", name: "z".repeat(20_000) } as ProviderEvent;
			yield { type: "tool_arguments_delta", id: "c1", delta: "{}" } as ProviderEvent;
			yield {
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			} as ProviderEvent;
		};
		const run = runAgent({ ...onceTool(bigTool(10)), turnLimit: 1 }, { callProvider: provider }, {
			message: userMessage("go"),
		});
		const events: AgentEvent[] = [];
		for await (const event of run) events.push(event);
		await run.result();
		const result = resultsOf(events)[0];
		expect(result).toBeDefined();
		if (!result) throw new Error("no tool result");
		expect(textOf(result)).toContain("[result truncated:");
	});

	test("each result of a batch keeps the whole budget", async () => {
		const provider: HarnessHost["callProvider"] = async function* () {
			yield { type: "tool_call_start", id: "c1", name: "big" } as ProviderEvent;
			yield { type: "tool_call_start", id: "c2", name: "big" } as ProviderEvent;
			yield { type: "tool_arguments_delta", id: "c1", delta: "{}" } as ProviderEvent;
			yield { type: "tool_arguments_delta", id: "c2", delta: "{}" } as ProviderEvent;
			yield {
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			} as ProviderEvent;
		};
		const run = runAgent({ ...onceTool(bigTool(20_000)), turnLimit: 1 }, { callProvider: provider }, {
			message: userMessage("go"),
		});
		const events: AgentEvent[] = [];
		for await (const event of run) events.push(event);
		await run.result();
		const results = resultsOf(events);
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(textOf(result)).toContain(`[result truncated: ${20_000 - 8192} of 20000 bytes omitted]`);
		}
	});

	test("the transcript entry the host receives is budgeted", async () => {
		const entries: { readonly message: AgentMessage }[] = [];
		const run = runAgent(
			{ ...onceTool(bigTool(20_000)), turnLimit: 1 },
			{ callProvider: callProvider(), append: (entry) => entries.push(entry) },
			{ message: userMessage("go") },
		);
		for await (const _event of run) {
			// drain
		}
		await run.result();
		const toolEntries = entries.filter((entry) => entry.message.role === "toolResult");
		expect(toolEntries).toHaveLength(1);
		const message = toolEntries[0]?.message;
		if (!message || message.role !== "toolResult") throw new Error("no tool result");
		expect(textOf(message)).toContain("[result truncated:");
	});

	test("the turn_end copy of the result is budgeted too", async () => {
		const run = runAgent(onceTool(bigTool(20_000)), { callProvider: callProvider() }, {
			message: userMessage("go"),
		});
		const events: AgentEvent[] = [];
		for await (const event of run) events.push(event);
		await run.result();
		const end = events.find((event) => event.type === "turn_end");
		if (!end || end.type !== "turn_end") throw new Error("no turn_end");
		expect(end.toolResults).toHaveLength(1);
		const result = end.toolResults[0];
		if (!result) throw new Error("no tool result");
		expect(textOf(result)).toContain("[result truncated:");
	});

	test("the provider's next request carries the budgeted result", async () => {
		const requests: ProviderRequest[] = [];
		const provider: HarnessHost["callProvider"] = async function* (request) {
			requests.push(request);
			yield { type: "tool_call_start", id: "c1", name: "big" } as ProviderEvent;
			yield { type: "tool_arguments_delta", id: "c1", delta: "{}" } as ProviderEvent;
			yield {
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			} as ProviderEvent;
		};
		const run = runAgent({ ...onceTool(bigTool(20_000)), turnLimit: 2 }, { callProvider: provider }, {
			message: userMessage("go"),
		});
		for await (const _event of run) {
			// drain
		}
		await run.result();
		const last = requests[requests.length - 1];
		if (!last) throw new Error("no request");
		const toolMessages = last.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(toolMessages).toHaveLength(1);
		const message = toolMessages[0];
		if (!message) throw new Error("no tool result");
		expect(textOf(message)).toContain("[result truncated:");
	});

	test("non-text blocks pass through untouched", async () => {
		const withImage = {
			name: "big",
			description: "d",
			parameters: { kind: "object", properties: {} },
			execute: async () => ({
				content: [
					{ type: "text", text: "x".repeat(20_000) },
					{ type: "image", data: "BASE64", mimeType: "image/png" },
				],
			}),
		} as unknown as ToolDefinition;
		const result = (await recordedResult(onceTool(withImage)))[0];
		if (!result) throw new Error("no tool result");
		expect(result.content.some((block) => block.type === "image")).toBe(true);
	});

	test("a result of exactly the budget passes verbatim", async () => {
		const result = (await recordedResult(onceTool(bigTool(8192))))[0];
		if (!result) throw new Error("no tool result");
		expect(textOf(result)).toBe("x".repeat(8192));
		expect(result.content).toHaveLength(1);
	});
	test("the live progress channel is budgeted too", async () => {
		const loud: ToolDefinition = {
			name: "big",
			description: "d",
			parameters: { kind: "object", properties: {} },
			execute: async (_call, _args, _signal, report) => {
				report?.({ content: [{ type: "text", text: "x".repeat(20_000) }] });
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const run = runAgent(onceTool(loud), { callProvider: callProvider() }, {
			message: userMessage("go"),
		});
		const events: AgentEvent[] = [];
		for await (const event of run) events.push(event);
		await run.result();
		const update = events.find((event) => event.type === "tool_execution_update");
		if (!update || update.type !== "tool_execution_update") throw new Error("no update");
		const text = update.partialResult.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).toContain("[result truncated:");
	});
});
