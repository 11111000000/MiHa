import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import { DEFAULT_TOOL_TIMEOUT, resolveToolTimeout } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import type { ProviderEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import { userMessage } from "../src/core/messages.ts";

/**
 * The tool timeout (ADR 0017): a tool that never settles must not hold the run open
 * forever. The call is answered with an ordinary error result, the tool is told, and
 * the tool's late answer is ignored.
 */

function config(over: Partial<HarnessConfig> = {}): HarnessConfig {
	return { model: "test-model", system: "you are a test", tools: toolRegistry([]), turnLimit: 8, ...over };
}

function provider(): HarnessHost["callProvider"] {
	// One call, then the run ends: a provider that always asked again would keep the
	// loop busy, and the test would measure turns instead of the timeout.
	let turn = 0;
	return async function* (_request: ProviderRequest) {
		turn += 1;
		if (turn > 1) {
			yield {
				type: "done",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			} as ProviderEvent;
			return;
		}
		yield { type: "tool_call_start", id: "c1", name: "slow" } as ProviderEvent;
		yield { type: "tool_arguments_delta", id: "c1", delta: "{}" } as ProviderEvent;
		yield {
			type: "done",
			stopReason: "toolUse",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		} as ProviderEvent;
	};
}

async function collect(run: ReturnType<typeof runAgent>) {
	const events = [];
	for await (const event of run) events.push(event);
	return { events, outcome: await run.result() };
}

describe("the tool timeout", () => {
	test("a tool that outlives the timeout is answered with an error result", async () => {
		const slow: ToolDefinition = {
			name: "slow",
			description: "never finishes",
			parameters: { kind: "object", properties: {} },
			execute: async () => new Promise(() => {}),
		};
		const run = runAgent(
			config({ tools: toolRegistry([slow]), toolTimeout: 40 }),
			{ callProvider: provider() },
			{ message: userMessage("go") },
		);
		const { events } = await collect(run);

		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const answers = end.messages.filter((message) => message.role === "toolResult");
		expect(answers).toHaveLength(1);
		const answer = answers[0];
		if (!answer || answer.role !== "toolResult") throw new Error("no answer");
		expect(answer.isError).toBe(true);
		expect(answer.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("did not finish"),
		});
	});

	test("the tool is told through its signal", async () => {
		let told = false;
		const slow: ToolDefinition = {
			name: "slow",
			description: "never finishes",
			parameters: { kind: "object", properties: {} },
			execute: async (_call, _args, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						told = true;
						reject(new Error("aborted"));
					});
				}),
		};
		const run = runAgent(
			config({ tools: toolRegistry([slow]), toolTimeout: 40 }),
			{ callProvider: provider() },
			{ message: userMessage("go") },
		);
		await collect(run);
		expect(told).toBe(true);
	});

	test("the tool's late answer is ignored: the call is answered once", async () => {
		let release: (() => void) | undefined;
		const slow: ToolDefinition = {
			name: "slow",
			description: "late",
			parameters: { kind: "object", properties: {} },
			execute: async () =>
				new Promise((resolve) => {
					release = () => resolve({ content: [{ type: "text", text: "late" }] });
				}),
		};
		const run = runAgent(
			config({ tools: toolRegistry([slow]), toolTimeout: 40 }),
			{ callProvider: provider() },
			{ message: userMessage("go") },
		);
		const { events } = await collect(run);
		release?.();
		await new Promise((resolve) => setTimeout(resolve, 10));

		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		expect(end.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	});

	test("a tool that finishes in time is untouched", async () => {
		const quick: ToolDefinition = {
			name: "slow",
			description: "quick",
			parameters: { kind: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "done" }] }),
		};
		const run = runAgent(
			config({ tools: toolRegistry([quick]), toolTimeout: 5000 }),
			{ callProvider: provider() },
			{ message: userMessage("go") },
		);
		const { events, outcome } = await collect(run);
		expect(outcome).toEqual({ kind: "completed" });
		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const answers = end.messages.filter((message) => message.role === "toolResult");
		expect(answers[0]?.role === "toolResult" ? answers[0].isError : true).toBe(false);
	});

	test("the default is 120 s, and nonsense is the default", () => {
		expect(DEFAULT_TOOL_TIMEOUT).toBe(120_000);
		expect(resolveToolTimeout(undefined)).toBe(DEFAULT_TOOL_TIMEOUT);
		expect(resolveToolTimeout(Number.NaN)).toBe(DEFAULT_TOOL_TIMEOUT);
		expect(resolveToolTimeout(-1)).toBe(DEFAULT_TOOL_TIMEOUT);
		expect(resolveToolTimeout(0)).toBe(DEFAULT_TOOL_TIMEOUT);
		expect(resolveToolTimeout(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
		expect(resolveToolTimeout(500)).toBe(500);
	});
});
