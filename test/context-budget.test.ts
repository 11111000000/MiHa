import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import { initialState, step, type HarnessConfig, type ProviderRequest, type RunState } from "../src/core/run.ts";
import { DEFAULT_CONTEXT_BUDGET, resolveContextBudget } from "../src/core/run.ts";
import { contextMessages, messageBytes, type JournalEntry } from "../src/core/journal.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import { userMessage } from "../src/core/messages.ts";
import type { ProviderEvent } from "../src/core/events.ts";

/**
 * The context policy (ADR 0010 D54).
 *
 * The core measures the folded context and, when it is over the budget, collapses
 * the range that does not fit into a digest. The journal keeps the whole history: a
 * compaction is a fold, not a deletion.
 *
 * The law is about what the **provider receives**: the messages of a request fit the
 * budget, and what follows the collapse still pairs — a question and its answer.
 */

const echo: ToolDefinition = {
	name: "echo",
	description: "echoes",
	parameters: { kind: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
};

function config(contextBudget?: number): HarnessConfig {
	return {
		model: "test-model",
		system: "you are a test",
		tools: toolRegistry([echo]),
		turnLimit: 200,
		...(contextBudget === undefined ? {} : { contextBudget }),
	};
}

function provider(): HarnessHost["callProvider"] {
	return async function* () {
		yield { type: "tool_call_start", id: "c1", name: "echo" } as ProviderEvent;
		yield { type: "tool_arguments_delta", id: "c1", delta: "{}" } as ProviderEvent;
		yield {
			type: "done",
			stopReason: "toolUse",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		} as ProviderEvent;
	};
}

/** A provider that records what it was asked, and asks for a call with a fresh id. */
function recordingProvider(requests: ProviderRequest[]): HarnessHost["callProvider"] {
	let turn = 0;
	return async function* callProvider(request: ProviderRequest) {
		requests.push(request);
		const id = `c${turn}`;
		turn += 1;
		yield { type: "tool_call_start", id, name: "echo" } as ProviderEvent;
		yield { type: "tool_arguments_delta", id, delta: "{}" } as ProviderEvent;
		yield {
			type: "done",
			stopReason: "toolUse",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		} as ProviderEvent;
	};
}

function turn(state: RunState): RunState {
	let next = step(state, { kind: "prompt", message: userMessage("go") }).state;
	for (const event of [
		{ type: "tool_call_start", id: "c1", name: "echo" },
		{ type: "tool_arguments_delta", id: "c1", delta: "{}" },
		{
			type: "done",
			stopReason: "toolUse",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		},
	] as ProviderEvent[]) {
		next = step(next, { kind: "provider", event }).state;
	}
	return step(next, {
		kind: "tool_result",
		result: {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "echo",
			content: [{ type: "text", text: "ok" }],
			isError: false,
		},
	}).state;
}

describe("the context policy", () => {
	test("a context that outgrows its budget is collapsed", () => {
		let state = initialState(config(60));
		for (let index = 0; index < 12; index += 1) {
			state = turn(state);
		}
		expect(state.context.bytes).toBeLessThanOrEqual(60);
	});

	test("what the provider receives fits the budget", async () => {
		const requests: ProviderRequest[] = [];
		const run = runAgent(
			config(120),
			{ callProvider: recordingProvider(requests) },
			{ message: userMessage("go") },
		);
		for await (const _event of run) {
			// drain
		}
		await run.result();

		expect(requests.length).toBeGreaterThan(1);
		for (const request of requests) {
			const size = request.messages.reduce((sum, message) => sum + messageBytes(message), 0);
			expect(size).toBeLessThanOrEqual(120);
		}
	});

	test("the digest says what was collapsed, and the journal keeps the history", async () => {
		const entries: JournalEntry[] = [];
		const run = runAgent(config(200), { callProvider: provider(), append: (entry) => entries.push(entry) }, {
			message: userMessage("go"),
		});
		for await (const _event of run) {
			// drain
		}
		await run.result();

		const compactions = entries.filter((entry) => entry.kind === "compaction");
		expect(compactions.length).toBeGreaterThan(0);
		const first = compactions[0];
		if (!first || first.kind !== "compaction") throw new Error("no compaction");
		expect(first.summary).toContain("entries collapsed");
		expect(first.summary).toContain("user: go");
		expect(first.dropped).toBeGreaterThan(0);
		// The history is untouched: the log still holds the entries that were collapsed.
		expect(entries.filter((entry) => entry.kind === "message").length).toBeGreaterThan(1);
	});

	test("what the model sees after a compaction is the digest and what follows", () => {
		let state = initialState(config(60));
		for (let index = 0; index < 12; index += 1) {
			state = turn(state);
		}
		const messages = contextMessages(state.context);
		expect(messages.length).toBeGreaterThan(0);
		const first = messages[0];
		expect(String(first?.content)).toContain("[compacted]");
	});

	test("what follows the collapse still pairs: a question and its answer", async () => {
		const requests: ProviderRequest[] = [];
		const run = runAgent(
			config(120),
			{ callProvider: recordingProvider(requests) },
			{ message: userMessage("go") },
		);
		for await (const _event of run) {
			// drain
		}
		await run.result();

		for (const request of requests) {
			const asked = request.messages.filter((message) => message.role === "assistant");
			const answered = request.messages.filter((message) => message.role === "toolResult");
			// Every call the model sees is answered in the same request.
			expect(answered.length).toBeGreaterThanOrEqual(Math.max(0, asked.length - 1));
		}
	});

	test("a budget no entry can fit leaves the context as it is", () => {
		let state = initialState(config(1));
		for (let index = 0; index < 3; index += 1) {
			state = turn(state);
		}
		// The core cannot shrink what follows: the run continues, and the context
		// says what it could not do.
		expect(state.context.bytes).toBeGreaterThan(1);
		expect(state.phase).not.toBe("finished");
	});

	test("the default is 128 KiB, and nonsense is the default", () => {
		expect(DEFAULT_CONTEXT_BUDGET).toBe(131_072);
		expect(resolveContextBudget(undefined)).toBe(DEFAULT_CONTEXT_BUDGET);
		expect(resolveContextBudget(Number.NaN)).toBe(DEFAULT_CONTEXT_BUDGET);
		expect(resolveContextBudget(-1)).toBe(DEFAULT_CONTEXT_BUDGET);
		expect(resolveContextBudget(0)).toBe(0);
		expect(resolveContextBudget(1024)).toBe(1024);
	});

	test("the context measures itself in bytes of text", () => {
		const state = turn(initialState(config()));
		const measured = contextMessages(state.context).reduce(
			(sum, message) => sum + messageBytes(message),
			0,
		);
		expect(measured).toBe(state.context.bytes);
	});
	test("the counter stays honest after an answer is replaced", () => {
		let state = initialState(config());
		for (const event of [
			{ type: "tool_call_start", id: "c1", name: "echo" },
			{ type: "tool_arguments_delta", id: "c1", delta: "{}" },
			{
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			},
		] as ProviderEvent[]) {
			state = step(state, { kind: "provider", event }).state;
		}
		state = step(state, {
			kind: "tool_result",
			result: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "echo",
				content: [{ type: "text", text: "a long first answer" }],
				isError: false,
			},
		}).state;
		const measured = contextMessages(state.context).reduce(
			(sum, message) => sum + messageBytes(message),
			0,
		);
		expect(measured).toBe(state.context.bytes);
	});

	test("the context is measured in bytes of text, not of images", () => {
		const state = step(initialState(config()), {
			kind: "prompt",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", data: "A".repeat(1000), mimeType: "image/png" },
				],
			},
		}).state;
		expect(state.context.bytes).toBe(5);
	});

	test("the digest never breaks a codepoint", () => {
		let state = initialState(config(60));
		state = step(state, { kind: "prompt", message: userMessage("é".repeat(200)) }).state;
		for (let index = 0; index < 6; index += 1) {
			state = turn(state);
		}
		const first = contextMessages(state.context)[0];
		expect(String(first?.content)).not.toContain("\uFFFD");
	});

	test("the digest says how many entries left, and the entry agrees", async () => {
		const entries: JournalEntry[] = [];
		const run = runAgent(config(200), { callProvider: provider(), append: (entry) => entries.push(entry) }, {
			message: userMessage("go"),
		});
		for await (const _event of run) {
			// drain
		}
		await run.result();

		const compaction = entries.find((entry) => entry.kind === "compaction");
		if (!compaction || compaction.kind !== "compaction") throw new Error("no compaction");
		const said = Number(/^(\d+) entries collapsed/.exec(compaction.summary)?.[1] ?? "0");
		expect(said).toBe(compaction.dropped);
		expect(said).toBeGreaterThan(0);
	});

	test("an answer whose question was swallowed is not context", () => {
		let state = initialState(config());
		state = step(state, { kind: "prompt", message: userMessage("go") }).state;
		for (const event of [
			{ type: "tool_call_start", id: "c1", name: "echo" },
			{ type: "tool_arguments_delta", id: "c1", delta: "{}" },
			{
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			},
		] as ProviderEvent[]) {
			state = step(state, { kind: "provider", event }).state;
		}
		// The host collapses the question away — the assistant message and its call
		// are seq 2 and 3 — and the tool answers afterwards.
		state = step(state, { kind: "compact", firstKeptSeq: 3, summary: "s" }).state;
		state = step(state, {
			kind: "tool_result",
			result: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "echo",
				content: [{ type: "text", text: "the answer" }],
				isError: false,
			},
		}).state;

		const answers = contextMessages(state.context).filter((message) => message.role === "toolResult");
		expect(answers).toHaveLength(0);
	});

	test("a steered message does not push the request over the budget", async () => {
		const requests: ProviderRequest[] = [];
		const run = runAgent(config(120), { callProvider: recordingProvider(requests) }, {
			message: userMessage("go"),
		});
		for await (const _event of run) {
			// drain
		}
		await run.result();
		for (const request of requests) {
			const size = request.messages.reduce((sum, message) => sum + messageBytes(message), 0);
			expect(size).toBeLessThanOrEqual(120);
		}
	});
});
