import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import type { ProviderEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import { userMessage, type AgentMessage, type ToolResult } from "../src/core/messages.ts";
import type { ToolCallPlan } from "../src/core/tools.ts";

/**
 * A provider that replays a script.
 *
 * The script is a list of turns; each turn is the list of events the provider emits.
 * The same shape a real adapter has, which is the point: the core cannot tell the
 * difference.
 */
function scriptedProvider(script: readonly (readonly ProviderEvent[])[]): HarnessHost["callProvider"] {
	let turn = 0;
	return async function* callProvider(_request: ProviderRequest) {
		const events = script[turn] ?? [];
		turn += 1;
		for (const event of events) yield event;
	};
}

const readFile: ToolDefinition = {
	name: "read_file",
	description: "reads a file",
	parameters: {
		kind: "object",
		properties: { path: { kind: "string" } },
		required: ["path"],
	},
	execute: async (call) => {
		const args = JSON.parse(call.argumentsText) as { path: string };
		return { content: [{ type: "text", text: `contents of ${args.path}` }] };
	},
};

function config(turnLimit = 8): HarnessConfig {
	return {
		model: "test-model",
		system: "you are a test",
		tools: toolRegistry([readFile]),
		turnLimit,
	};
}

function host(
	callProvider: HarnessHost["callProvider"],
	callTool?: (plan: ToolCallPlan) => Promise<ToolResult>,
): HarnessHost {
	return {
		callProvider,
		callTool: async (plan) => {
			if (callTool) return callTool(plan);
			return plan.tool.execute(plan.call, new AbortController().signal, () => {});
		},
	};
}

function done(stopReason: "stop" | "toolUse"): ProviderEvent {
	return {
		type: "done",
		stopReason,
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
	};
}

async function collect(run: ReturnType<typeof runAgent>) {
	const events = [];
	for await (const event of run) events.push(event);
	return { events, outcome: await run.result() };
}

describe("one scenario, end to end", () => {
	test("the agent reads a file, then answers", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "text_delta", delta: "Let me look." },
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[
				{ type: "text_delta", delta: "It says hello." },
				done("stop"),
			],
		];

		const run = runAgent(
			config(),
			host(scriptedProvider(script)),
			{ message: userMessage("what is in a.txt?") },
		);
		const { events, outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });

		const kinds = events.map((event) => event.type);
		expect(kinds[0]).toBe("agent_start");
		expect(kinds[kinds.length - 1]).toBe("agent_end");
		expect(kinds).toContain("turn_start");
		expect(kinds).toContain("tool_execution_start");
		expect(kinds).toContain("tool_execution_end");
		expect(kinds).toContain("turn_end");
		expect(kinds.filter((kind) => kind === "turn_start")).toHaveLength(2);
	});

	test("the transcript holds the whole conversation", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "hello" }, done("stop")],
		];

		const run = runAgent(config(), host(scriptedProvider(script)), {
			message: userMessage("read a.txt"),
		});
		const { events } = await collect(run);

		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const roles = end.messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	test("the tool result reaches the model", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "done" }, done("stop")],
		];

		let seen: readonly AgentMessage[] = [];
		const capture: HarnessHost["callProvider"] = async function* (request) {
			seen = request.messages;
			yield* scriptedProvider(script)(request, new AbortController().signal);
		};

		const run = runAgent(config(), host(capture), { message: userMessage("read a.txt") });
		await collect(run);

		const toolResult = seen.find((message) => message.role === "toolResult");
		if (!toolResult || toolResult.role !== "toolResult") throw new Error("no tool result");
		expect(toolResult.content[0]).toEqual({ type: "text", text: "contents of a.txt" });
		expect(toolResult.isError).toBe(false);
	});
});

describe("law M1 — the pairing survives every path", () => {
	test("an unknown tool still gets a result", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "nosuch" },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "sorry" }, done("stop")],
		];

		const run = runAgent(config(), host(scriptedProvider(script)), {
			message: userMessage("do it"),
		});
		const { events } = await collect(run);

		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const toolResults = end.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		if (toolResults[0]?.role !== "toolResult") throw new Error("no tool result");
		expect(toolResults[0].isError).toBe(true);
	});

	test("a failing tool still gets a result", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "sorry" }, done("stop")],
		];

		const run = runAgent(
			config(),
			host(scriptedProvider(script), async () => {
				throw new Error("the disk is on fire");
			}),
			{ message: userMessage("read a.txt") },
		);
		const { events } = await collect(run);

		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const toolResults = end.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		if (toolResults[0]?.role !== "toolResult") throw new Error("no tool result");
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].content[0]).toEqual({ type: "text", text: "the disk is on fire" });
	});
});

describe("law M4 — a provider failure is an event", () => {
	test("a provider error ends the run without a throw", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [[{ type: "error", message: "the provider is down" }]];

		const run = runAgent(config(), host(scriptedProvider(script)), {
			message: userMessage("hello"),
		});
		const { events, outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const assistant = end.messages.find((message) => message.role === "assistant");
		if (!assistant || assistant.role !== "assistant") throw new Error("no assistant message");
		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toBe("the provider is down");
	});
});

describe("the turn limit is a policy", () => {
	test("a run that will not stop says so", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[
				{ type: "tool_call_start", id: "c2", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c2", delta: '{"path":"b.txt"}' },
				done("toolUse"),
			],
		];

		const run = runAgent(config(2), host(scriptedProvider(script)), {
			message: userMessage("loop"),
		});
		const { outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "limitReached", turns: 2 });
	});
});

describe("cancellation", () => {
	test("a cancelled run ends, and its calls are still answered", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
		];

		const controller = new AbortController();
		const run = runAgent(config(), host(scriptedProvider(script)), {
			message: userMessage("read a.txt"),
			signal: controller.signal,
		});

		controller.abort();
		const { outcome } = await collect(run);
		expect(outcome.kind).toBe("cancelled");
	});
});
