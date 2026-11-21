import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import type { AgentEvent, ProviderEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import {
	userMessage,
	type AgentMessage,
	type ToolResult,
	type ToolResultMessage,
} from "../src/core/messages.ts";
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
	execute: async (_call, args) => {
		const path = String(args.path);
		return { content: [{ type: "text", text: `contents of ${path}` }] };
	},
};

/** An exclusive tool: it never shares a group with another exclusive tool (T1). */
const listDir: ToolDefinition = {
	name: "list_dir",
	description: "lists a directory",
	parameters: { kind: "object", properties: {} },
	concurrency: "exclusive",
	execute: async () => ({ content: [{ type: "text", text: "entries" }] }),
};

function config(turnLimit = 8, tools: readonly ToolDefinition[] = [readFile]): HarnessConfig {
	return {
		model: "test-model",
		system: "you are a test",
		tools: toolRegistry(tools),
		turnLimit,
	};
}

/**
 * The host does not run tools: the driver does. The host owns the provider and the
 * permission hook, and that is all it needs to own.
 */
function host(callProvider: HarnessHost["callProvider"]): HarnessHost {
	return { callProvider };
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

/** The transcript the run ended with — the messages, in the order they were recorded. */
function transcriptOf(events: readonly AgentEvent[]): readonly AgentMessage[] {
	const end = events.find((event) => event.type === "agent_end");
	if (!end) throw new Error("no agent_end");
	return end.messages;
}

/** The tool results of a transcript, in the order they were recorded (law T4). */
function toolResultsOf(messages: readonly AgentMessage[]): readonly ToolResultMessage[] {
	return messages.filter((message) => message.role === "toolResult");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A latch the test waits on and the tool opens. */
function latch(): { readonly open: Promise<void>; readonly release: () => void } {
	let release: () => void = () => {};
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { open, release };
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

		const burningRead: ToolDefinition = {
			name: "read_file",
			description: "reads a file",
			parameters: { kind: "object", properties: { path: { kind: "string" } }, required: ["path"] },
			execute: async () => {
				throw new Error("the disk is on fire");
			},
		};

		const run = runAgent(config(8, [burningRead]), host(scriptedProvider(script)), {
			message: userMessage("read a.txt"),
		});
		const { events } = await collect(run);

		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const toolResults = end.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		if (toolResults[0]?.role !== "toolResult") throw new Error("no tool result");
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].content[0]).toEqual({ type: "text", text: "the disk is on fire" });
	});

	test("a call cut short by the output limit is answered, and never executed", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a' },
				{
					type: "done",
					stopReason: "length",
					usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
				},
			],
		];

		let executed = false;
		const countingRead: ToolDefinition = {
			name: "read_file",
			description: "reads a file",
			parameters: { kind: "object", properties: { path: { kind: "string" } }, required: ["path"] },
			execute: async () => {
				executed = true;
				return { content: [] };
			},
		};

		const run = runAgent(
			config(8, [countingRead]),
			host(scriptedProvider(script)),
			{ message: userMessage("read a.txt") },
		);
		const { events } = await collect(run);

		const results = toolResultsOf(transcriptOf(events));
		expect(results).toHaveLength(1);
		expect(results[0]?.toolCallId).toBe("c1");
		expect(results[0]?.isError).toBe(true);
		expect(executed).toBe(false);
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

	test("a provider failure after a call leaves the call answered", async () => {
		// The provider streamed a call and then died. The call is in the transcript,
		// so the transcript has to answer it, or the next request would carry a call
		// with no result (law M1).
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				{ type: "error", message: "the provider is down" },
			],
		];

		const run = runAgent(config(), host(scriptedProvider(script)), {
			message: userMessage("read a.txt"),
		});
		const { events } = await collect(run);

		const messages = transcriptOf(events);
		const results = toolResultsOf(messages);
		expect(results).toHaveLength(1);
		expect(results[0]?.toolCallId).toBe("c1");
		expect(results[0]?.isError).toBe(true);

		// The call itself stayed in the transcript, next to its answer.
		const assistant = messages.find((message) => message.role === "assistant");
		expect(assistant?.content).toContainEqual({
			type: "toolCall",
			id: "c1",
			name: "read_file",
			argumentsText: '{"path":"a.txt"}',
		});
	});
});

describe("law T4 — the results are recorded in assistant order", () => {
	test("a batch of two calls is recorded in assistant order, not completion order", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				{ type: "tool_call_start", id: "c2", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c2", delta: '{"path":"b.txt"}' },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "done" }, done("stop")],
		];

		// c1 is the slow one, so the calls complete in the opposite order to the one
		// the assistant asked in.
		const slowRead: ToolDefinition = {
			name: "read_file",
			description: "reads a file",
			parameters: { kind: "object", properties: { path: { kind: "string" } }, required: ["path"] },
			execute: async (call) => {
				if (call.id === "c1") await sleep(20);
				return {
					content: [
						{ type: "text", text: call.id === "c1" ? "contents of a.txt" : "contents of b.txt" },
					],
				};
			},
		};

		const run = runAgent(config(8, [slowRead]), host(scriptedProvider(script)), {
			message: userMessage("read both"),
		});
		const { events } = await collect(run);

		const results = toolResultsOf(transcriptOf(events));
		expect(results.map((result) => result.toolCallId)).toEqual(["c1", "c2"]);
		expect(results.map((result) => result.content[0])).toEqual([
			{ type: "text", text: "contents of a.txt" },
			{ type: "text", text: "contents of b.txt" },
		]);
	});
});

describe("policy T1 — the groups of a plan run in order", () => {
	test("the second group does not start before the first one ended", async () => {
		// Two exclusive calls, so the plan has two groups of one call each.
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "list_dir" },
				{ type: "tool_arguments_delta", id: "c1", delta: "{}" },
				{ type: "tool_call_start", id: "c2", name: "list_dir" },
				{ type: "tool_arguments_delta", id: "c2", delta: "{}" },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "done" }, done("stop")],
		];

		const order: string[] = [];
		const orderedList: ToolDefinition = {
			name: "list_dir",
			description: "lists a directory",
			parameters: { kind: "object", properties: {} },
			concurrency: "exclusive",
			execute: async (call) => {
				order.push(`start ${call.id}`);
				await sleep(call.id === "c1" ? 20 : 1);
				order.push(`end ${call.id}`);
				return { content: [{ type: "text", text: call.id }] };
			},
		};

		const run = runAgent(
			config(8, [orderedList]),
			host(scriptedProvider(script)),
			{ message: userMessage("list twice") },
		);
		await collect(run);

		expect(order).toEqual(["start c1", "end c1", "start c2", "end c2"]);
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
	test("a run whose signal is already aborted ends as cancelled", async () => {
		const controller = new AbortController();
		controller.abort();

		let asked = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			asked += 1;
		};

		const run = runAgent(config(), host(provider), {
			message: userMessage("read a.txt"),
			signal: controller.signal,
		});
		const { events, outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "cancelled" });
		expect(transcriptOf(events).map((message) => message.role)).toEqual(["user"]);
		// A run that was stopped before it started never talks to the provider.
		expect(asked).toBe(0);
	});

	test("a run aborted before the provider answers ends as cancelled", async () => {
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

	test("an abort while a tool is running ends the run, and the call is answered", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
		];

		const started = latch();
		const controller = new AbortController();
		const abortableRead: ToolDefinition = {
			name: "read_file",
			description: "reads a file",
			parameters: { kind: "object", properties: { path: { kind: "string" } }, required: ["path"] },
			execute: async (_call, _args, signal) => {
				started.release();
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				throw new Error("the tool was aborted");
			},
		};

		const run = runAgent(
			config(8, [abortableRead]),
			host(scriptedProvider(script)),
			{ message: userMessage("read a.txt"), signal: controller.signal },
		);

		// The tool is running: now the outside world stops the run.
		await started.open;
		controller.abort();

		const { events, outcome } = await collect(run);
		expect(outcome).toEqual({ kind: "cancelled" });

		const results = toolResultsOf(transcriptOf(events));
		expect(results).toHaveLength(1);
		expect(results[0]?.toolCallId).toBe("c1");
		expect(results[0]?.isError).toBe(true);
		// The answer is the cancellation's, not the tool's: the run was stopped
		// before the tool could report anything.
		expect(results[0]?.content[0]).toEqual({ type: "text", text: "cancelled" });
	});

	test("a call that is already answered is not answered twice", async () => {
		// The first turn answers c1. The second turn says nothing at all, so the run
		// is cancelled while the state still points at the finished batch.
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[],
		];

		const run = runAgent(config(), host(scriptedProvider(script)), {
			message: userMessage("read a.txt"),
		});
		const { events, outcome } = await collect(run);

		expect(outcome.kind).toBe("cancelled");

		const results = toolResultsOf(transcriptOf(events));
		expect(results).toHaveLength(1);
		expect(results[0]?.toolCallId).toBe("c1");
		expect(results[0]?.content[0]).toEqual({ type: "text", text: "contents of a.txt" });
	});
});
