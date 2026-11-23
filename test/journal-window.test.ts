import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import { initialState, step, type HarnessConfig, type RunState } from "../src/core/run.ts";
import {
	contextMessages,
	resolveJournalWindow,
	DEFAULT_JOURNAL_WINDOW,
	JOURNAL_VERSION,
	type JournalEntry,
} from "../src/core/journal.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import { toolResultMessage, userMessage, type AgentMessage } from "../src/core/messages.ts";
import type { Output } from "../src/core/run.ts";
import type { ProviderEvent } from "../src/core/events.ts";

/**
 * The resident window (law R1, ADR 0009 D52).
 *
 * The host holds the whole journal; the core keeps a window of it. The model's
 * context is whole regardless, because it is folded forward rather than recomputed
 * from the entries the core still holds.
 */

const echo: ToolDefinition = {
	name: "echo",
	description: "echoes",
	parameters: { kind: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
};

function config(): HarnessConfig {
	return {
		model: "test-model",
		system: "you are a test",
		tools: toolRegistry([echo]),
		turnLimit: 200,
	};
}

/** One turn of the core, driven by hand: a prompt, a call, its answer. */
function turn(state: RunState): RunState {
	let next = step(state, { kind: "prompt", message: userMessage("go") }).state;
	const events: ProviderEvent[] = [
		{ type: "tool_call_start", id: "c1", name: "echo" },
		{ type: "tool_arguments_delta", id: "c1", delta: "{}" },
		{ type: "done", stopReason: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
	];
	for (const event of events) {
		next = step(next, { kind: "provider", event }).state;
	}
	return step(next, {
		kind: "tool_result",
		result: toolResultMessage("c1", "echo", [{ type: "text", text: "ok" }], false),
	}).state;
}

describe("the resident window", () => {
	test("the core keeps a bounded journal while the context stays whole", () => {
		let state = initialState(config());
		for (let index = 0; index < 60; index += 1) {
			state = turn(state);
		}

		// The resident window is bounded ...
		expect(state.entries.length).toBeLessThanOrEqual(DEFAULT_JOURNAL_WINDOW);
		// ... and the context is not: every turn is still there.
		const messages = contextMessages(state.context);
		expect(messages.length).toBeGreaterThan(state.entries.length);
		expect(messages.filter((message) => message.role === "toolResult").length).toBe(60);
	});

	test("the host receives every entry the run produced", async () => {
		const entries: JournalEntry[] = [];
		const provider: HarnessHost["callProvider"] = async function* () {
			yield { type: "tool_call_start", id: "c1", name: "echo" } as ProviderEvent;
			yield { type: "tool_arguments_delta", id: "c1", delta: "{}" } as ProviderEvent;
			yield {
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			} as ProviderEvent;
		};
		const run = runAgent(config(), { callProvider: provider, append: (entry) => entries.push(entry) }, {
			message: userMessage("go"),
		});
		for await (const _event of run) {
			// drain
		}
		await run.result();

		// The host's log is longer than the core's window.
		expect(entries.length).toBeGreaterThan(DEFAULT_JOURNAL_WINDOW);
		const messages: AgentMessage[] = [];
		for (const entry of entries) {
			expect(entry.seq).toBeGreaterThan(0);
			messages.push(...[]);
		}
		expect(entries.map((entry) => entry.seq)).toEqual(
			entries.map((_entry, index) => index + 1),
		);
	});
	test("the core keeps the journal resident, newest entries first", () => {
		let state = initialState(config());
		for (let index = 0; index < 60; index += 1) {
			state = turn(state);
		}
		expect(state.entries.length).toBeGreaterThan(0);
		expect(state.entries[state.entries.length - 1]?.seq).toBe(state.nextId - 1);
		expect(state.entries[0]?.seq).toBe(state.nextId - state.entries.length);
	});

	test("the resident window is 64 entries", () => {
		let state = initialState(config());
		for (let index = 0; index < 60; index += 1) {
			state = turn(state);
		}
		expect(state.entries).toHaveLength(64);
	});

	test("every entry the core writes carries the journal's version", () => {
		const written: JournalEntry[] = [];
		let state = initialState(config());
		for (const output of step(state, { kind: "prompt", message: userMessage("go") }).outputs) {
			if (output.kind === "append") written.push(output.entry);
		}
		state = turn(state);
		expect(written.length).toBeGreaterThan(0);
		for (const entry of written) expect(entry.version).toBe(JOURNAL_VERSION);
	});

	test("the context still holds every message of the run", () => {
		let state = initialState(config());
		for (let index = 0; index < 60; index += 1) {
			state = turn(state);
		}
		const messages = contextMessages(state.context);
		expect(messages.filter((message) => message.role === "user")).toHaveLength(60);
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(60);
		expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(60);
	});

	test("a change leaves the resident history untouched", () => {
		let state = step(initialState(config()), { kind: "prompt", message: userMessage("go") }).state;
		state = step(state, {
			kind: "change",
			targetSeq: 1,
			content: [{ type: "text", text: "new" }],
		}).state;
		const target = state.entries.find((entry) => entry.seq === 1);
		expect(target?.kind).toBe("message");
		if (!target || target.kind !== "message" || target.role !== "user") throw new Error("no entry");
		expect(target.content).toBe("go");
	});

	test("the journal window is configurable", () => {
		let state = initialState({ ...config(), journalWindow: 8 });
		for (let index = 0; index < 10; index += 1) {
			state = turn(state);
		}
		expect(state.entries).toHaveLength(8);
	});
	test("a window of zero still keeps the journal bounded", () => {
		let state = initialState({ ...config(), journalWindow: 0 });
		for (let index = 0; index < 40; index += 1) {
			state = turn(state);
		}
		expect(state.entries.length).toBeLessThanOrEqual(DEFAULT_JOURNAL_WINDOW);
		expect(state.entries).toHaveLength(0);
	});

	test("a nonsense window is the default", () => {
		expect(resolveJournalWindow(undefined)).toBe(DEFAULT_JOURNAL_WINDOW);
		expect(resolveJournalWindow(Number.NaN)).toBe(DEFAULT_JOURNAL_WINDOW);
		expect(resolveJournalWindow(-1)).toBe(DEFAULT_JOURNAL_WINDOW);
		expect(resolveJournalWindow(0)).toBe(0);
		expect(resolveJournalWindow(8)).toBe(8);
	});

	test("the compaction says how many entries it collapsed", () => {
		let state = initialState(config());
		for (let index = 0; index < 10; index += 1) {
			state = turn(state);
		}
		const output = step(state, { kind: "compact", firstKeptSeq: 3, summary: "s" });
		const entry = output.outputs.find((item) => item.kind === "append")?.entry;
		if (!entry || entry.kind !== "compaction") throw new Error("no compaction");
		expect(entry.dropped).toBe(2);
	});

	test("the host receives the compaction entry too", () => {
		const entries: JournalEntry[] = [];
		let state = initialState(config());
		const outputs = step(state, { kind: "compact", firstKeptSeq: 1, summary: "s" }).outputs;
		for (const output of outputs) {
			if (output.kind === "append") entries.push(output.entry);
		}
		expect(entries).toHaveLength(1);
		expect(entries[0]?.kind).toBe("compaction");
	});

	test("the answers in the log do not grow across batches", () => {
		let state = initialState(config());
		state = turn(state);
		state = turn(state);
		expect(state.written).toEqual(["c1"]);
	});

	test("a refusal the run holds but never wrote is still answered", () => {
		let state = step(initialState(config()), { kind: "prompt", message: userMessage("go") }).state;
		for (const event of [
			{ type: "tool_call_start", id: "c1", name: "echo" },
			{ type: "tool_arguments_delta", id: "c1", delta: "{}" },
			{ type: "tool_call_start", id: "c2", name: "echo" },
			{ type: "tool_arguments_delta", id: "c2", delta: "{}" },
			{
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			},
		] as ProviderEvent[]) {
			state = step(state, { kind: "provider", event }).state;
		}
		state = step(state, {
			kind: "blocked",
			call: { type: "toolCall", id: "c1", name: "echo", argumentsText: "{}" },
			reason: "the user refused",
		}).state;
		state = step(state, { kind: "cancel" }).state;

		const answers = contextMessages(state.context).filter((message) => message.role === "toolResult");
		expect(answers).toHaveLength(2);
	});

	test("a tool result the run holds but never wrote is still answered", () => {
		let state = step(initialState(config()), { kind: "prompt", message: userMessage("go") }).state;
		for (const event of [
			{ type: "tool_call_start", id: "c1", name: "echo" },
			{ type: "tool_arguments_delta", id: "c1", delta: "{}" },
			{ type: "tool_call_start", id: "c2", name: "echo" },
			{ type: "tool_arguments_delta", id: "c2", delta: "{}" },
			{
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			},
		] as ProviderEvent[]) {
			state = step(state, { kind: "provider", event }).state;
		}
		// One answer of two: the batch does not close, so the answer is still held.
		state = step(state, {
			kind: "tool_result",
			result: toolResultMessage("c1", "echo", [{ type: "text", text: "the real answer" }], false),
		}).state;
		state = step(state, { kind: "cancel" }).state;

		const answers = contextMessages(state.context).filter((message) => message.role === "toolResult");
		expect(answers).toHaveLength(2);
		expect(answers[0]?.role === "toolResult" ? answers[0].content : []).toEqual([
			{ type: "text", text: "the real answer" },
		]);
	});
	test("every entry the run writes carries the journal's version", () => {
		const written: JournalEntry[] = [];
		const collect = (outputs: readonly Output[]): void => {
			for (const output of outputs) {
				if (output.kind === "append") written.push(output.entry);
			}
		};
		let state = initialState(config());
		const prompt = step(state, { kind: "prompt", message: userMessage("go") });
		state = prompt.state;
		collect(prompt.outputs);
		for (const event of [
			{ type: "tool_call_start", id: "c1", name: "echo" },
			{ type: "tool_arguments_delta", id: "c1", delta: "{}" },
			{
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			},
		] as ProviderEvent[]) {
			const result = step(state, { kind: "provider", event });
			state = result.state;
			collect(result.outputs);
		}
		const answer = step(state, {
			kind: "tool_result",
			result: toolResultMessage("c1", "echo", [{ type: "text", text: "ok" }], false),
		});
		collect(answer.outputs);

		expect(written.length).toBeGreaterThan(2);
		for (const entry of written) expect(entry.version).toBe(JOURNAL_VERSION);
	});

	test("the compaction never claims to have dropped more than the log holds", () => {
		let state = initialState(config());
		for (let index = 0; index < 10; index += 1) {
			state = turn(state);
		}
		const output = step(state, { kind: "compact", firstKeptSeq: 9999, summary: "s" });
		const entry = output.outputs.find((item) => item.kind === "append")?.entry;
		if (!entry || entry.kind !== "compaction") throw new Error("no compaction");
		expect(entry.dropped).toBe(state.nextId - 1);
	});

	test("the host receives the entries even when the run is cancelled at once", async () => {
		const entries: JournalEntry[] = [];
		const controller = new AbortController();
		controller.abort();
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					yield { type: "done", stopReason: "stop" } as ProviderEvent;
				},
				append: (entry) => entries.push(entry),
			},
			{ message: userMessage("go"), signal: controller.signal },
		);
		for await (const _event of run) {
			// drain
		}
		await run.result();
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.map((entry) => entry.seq)).toEqual([1]);
	});

	test("the host receives the entries even when the provider throws", async () => {
		const entries: JournalEntry[] = [];
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					yield { type: "done", stopReason: "stop" } as ProviderEvent;
					throw new Error("the provider exploded");
				},
				append: (entry) => entries.push(entry),
			},
			{ message: userMessage("go") },
		);
		for await (const _event of run) {
			// drain
		}
		await run.result().catch(() => undefined);
		expect(entries.length).toBeGreaterThan(0);
	});
});
