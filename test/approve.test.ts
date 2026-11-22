import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/core/loop.ts";
import type { ApproveContext, ApproveDecision, HarnessHost } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import type { AgentEvent, ProviderEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import type { AgentMessage, ToolResultMessage } from "../src/core/messages.ts";
import { userMessage } from "../src/core/messages.ts";

/**
 * The approve seam (ADR 0008 D44): the host is asked before each tool runs, and the
 * ask may wait for a human. What the tests pin down:
 *
 *   - a denial becomes an error tool result the model reads, and the tool never runs
 *   - a rewrite is re-validated; only a valid one reaches the tool
 *   - the host sees the call, the tool and the already-validated arguments
 *   - with no seam, every planned tool runs
 */

function scriptedProvider(
	script: readonly (readonly ProviderEvent[])[],
): HarnessHost["callProvider"] {
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
	execute: async (_call, args) => ({
		content: [{ type: "text", text: `contents of ${String(args.path)}` }],
	}),
};

const count: ToolDefinition = {
	name: "count",
	description: "counts",
	parameters: {
		kind: "object",
		properties: { n: { kind: "number", coerce: true } },
		required: ["n"],
	},
	execute: async () => ({ content: [{ type: "text", text: "counted" }] }),
};

function config(turnLimit = 8, tools: readonly ToolDefinition[] = [readFile]): HarnessConfig {
	return {
		model: "test-model",
		system: "you are a test",
		tools: toolRegistry(tools),
		turnLimit,
	};
}

function host(
	callProvider: HarnessHost["callProvider"],
	approve?: (context: ApproveContext) => Promise<ApproveDecision>,
): HarnessHost {
	return approve ? { callProvider, approve } : { callProvider };
}

function done(stopReason: "stop" | "toolUse"): ProviderEvent {
	return {
		type: "done",
		stopReason,
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
	};
}

/** One turn that calls read_file on a.txt, then one turn that stops. */
const callThenStop: readonly (readonly ProviderEvent[])[] = [
	[
		{ type: "tool_call_start", id: "c1", name: "read_file" },
		{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
		done("toolUse"),
	],
	[{ type: "text_delta", delta: "done" }, done("stop")],
];

async function collect(run: ReturnType<typeof runAgent>) {
	const events: AgentEvent[] = [];
	for await (const event of run) events.push(event);
	return { events, outcome: await run.result() };
}

function toolResultsOf(events: readonly AgentEvent[]): readonly ToolResultMessage[] {
	const end = events.find((event) => event.type === "agent_end");
	if (!end) throw new Error("no agent_end");
	return (end.messages as readonly AgentMessage[]).filter(
		(message) => message.role === "toolResult",
	) as readonly ToolResultMessage[];
}

describe("the approve seam", () => {
	test("a denial becomes an error result the model reads, and the tool never runs", async () => {
		const seen: string[] = [];
		const run = runAgent(config(), host(scriptedProvider(callThenStop), async (context) => {
			seen.push(context.call.name);
			return { kind: "deny", reason: "the user refused" };
		}), { message: userMessage("what is in a.txt?") });

		const { events, outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		expect(seen).toEqual(["read_file"]);
		const results = toolResultsOf(events);
		expect(results).toHaveLength(1);
		expect(results[0]?.toolCallId).toBe("c1");
		expect(results[0]?.isError).toBe(true);
		expect(results[0]?.content[0]).toEqual({ type: "text", text: "the user refused" });
	});

	test("a rewrite reaches the tool re-validated", async () => {
		const received: string[] = [];
		const tool: ToolDefinition = {
			...readFile,
			execute: async (_call, args) => {
				received.push(String(args.path));
				return { content: [{ type: "text", text: `contents of ${String(args.path)}` }] };
			},
		};
		const run = runAgent(config(8, [tool]), host(scriptedProvider(callThenStop), async () => ({
			kind: "rewrite",
			args: { path: "safe.txt" },
		})), { message: userMessage("what is in a.txt?") });

		const { outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		expect(received).toEqual(["safe.txt"]);
	});

	test("a rewrite that breaks the schema is refused rather than run", async () => {
		let ran = 0;
		const tool: ToolDefinition = {
			...readFile,
			execute: async () => {
				ran += 1;
				return { content: [] };
			},
		};
		const run = runAgent(config(8, [tool]), host(scriptedProvider(callThenStop), async () => ({
			kind: "rewrite",
			args: { path: 42 },
		})), { message: userMessage("what is in a.txt?") });

		const { events, outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		expect(ran).toBe(0);
		const results = toolResultsOf(events);
		expect(results).toHaveLength(1);
		expect(results[0]?.isError).toBe(true);
		expect(results[0]?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("host rewrote the arguments badly"),
		});
	});

	test("the host sees the call, the tool and the already-validated arguments", async () => {
		let seen: ApproveContext | undefined;
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "count" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"n":"42"}' },
				done("toolUse"),
			],
			[done("stop")],
		];
		const run = runAgent(config(8, [count]), host(scriptedProvider(script), async (context) => {
			seen = context;
			return { kind: "allow" };
		}), { message: userMessage("count" ) });

		await collect(run);

		expect(seen?.call.id).toBe("c1");
		expect(seen?.tool.name).toBe("count");
		expect(seen?.args).toEqual({ n: 42 });
	});

	test("a denial never runs the tool", async () => {
		let ran = 0;
		const tool: ToolDefinition = {
			...readFile,
			execute: async () => {
				ran += 1;
				return { content: [] };
			},
		};
		const run = runAgent(config(8, [tool]), host(scriptedProvider(callThenStop), async () => ({
			kind: "deny" as const,
			reason: "the user refused",
		})), { message: userMessage("what is in a.txt?") });

		const { outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		expect(ran).toBe(0);
	});

	test("an approve that throws becomes a failure result, not a dead run", async () => {
		const run = runAgent(config(8, [readFile]), host(scriptedProvider(callThenStop), async () => {
			throw new Error("host exploded");
		}), { message: userMessage("what is in a.txt?") });

		const { events, outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		const results = toolResultsOf(events);
		expect(results).toHaveLength(1);
		expect(results[0]?.isError).toBe(true);
		expect(results[0]?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("host exploded"),
		});
	});

	test("two calls in one group are each asked, each with its own call", async () => {
		const asks: string[] = [];
		const received: string[] = [];
		const tool: ToolDefinition = {
			...readFile,
			execute: async (call, args) => {
				received.push(`${call.id}:${String(args.path)}`);
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				{ type: "tool_call_start", id: "c2", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c2", delta: '{"path":"b.txt"}' },
				done("toolUse"),
			],
			[done("stop")],
		];
		const run = runAgent(config(8, [tool]), host(scriptedProvider(script), async (context) => {
			asks.push(context.call.id);
			return context.call.id === "c1"
				? { kind: "rewrite" as const, args: { path: "safe.txt" } }
				: { kind: "allow" as const };
		}), { message: userMessage("both") });

		const { outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		expect(asks).toEqual(["c1", "c2"]);
		expect(received).toEqual(["c1:safe.txt", "c2:b.txt"]);
	});

	test("a rewrite reaches the tool as the validated value, not the raw host text", async () => {
		let received: unknown;
		const tool: ToolDefinition = {
			...count,
			execute: async (_call, args) => {
				received = (args as { n: unknown }).n;
				return { content: [{ type: "text", text: "counted" }] };
			},
		};
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "count" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"n":"7"}' },
				done("toolUse"),
			],
			[done("stop")],
		];
		const run = runAgent(config(8, [tool]), host(scriptedProvider(script), async () => ({
			kind: "rewrite" as const,
			args: { n: "42" },
		})), { message: userMessage("count") });

		const { outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		expect(received).toBe(42);
	});

	test("with no seam, every planned tool runs", async () => {
		let ran = 0;
		const tool: ToolDefinition = {
			...readFile,
			execute: async () => {
				ran += 1;
				return { content: [{ type: "text", text: "contents" }] };
			},
		};
		const run = runAgent(config(8, [tool]), host(scriptedProvider(callThenStop)), {
			message: userMessage("what is in a.txt?"),
		});

		const { outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		expect(ran).toBe(1);
	});
});
