import { describe, expect, test } from "bun:test";
import { initialState, phaseOf, step } from "../src/core/run.ts";
import type { HarnessConfig, Input, RunState } from "../src/core/run.ts";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import { toolResultMessage, userMessage } from "../src/core/messages.ts";
import type { AgentEvent, ProviderEvent } from "../src/core/events.ts";
import type { JournalEntry } from "../src/core/journal.ts";

/**
 * The phase of a run is a label of what the run holds (ADR 0008 D48).
 *
 * It is not a field: it is computed every time it is read. The tests below say three
 * things about that: the phase follows the state, the phase is not stored, and the
 * driver reads it.
 */

const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

const readFile: ToolDefinition = {
	name: "read_file",
	description: "reads a file",
	parameters: {
		kind: "object",
		properties: { path: { kind: "string" } },
		required: ["path"],
	},
	execute: async () => ({ content: [{ type: "text", text: "contents of a.txt" }] }),
};

function config(turnLimit = 8): HarnessConfig {
	return {
		model: "test-model",
		system: "you are a test",
		tools: toolRegistry([readFile]),
		turnLimit,
	};
}

/** The calls the model asks for: two, so a batch can be half answered. */
const asks: readonly ProviderEvent[] = [
	{ type: "tool_call_start", id: "c1", name: "read_file" },
	{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
	{ type: "tool_call_start", id: "c2", name: "read_file" },
	{ type: "tool_arguments_delta", id: "c2", delta: '{"path":"b.txt"}' },
	{ type: "done", stopReason: "toolUse", usage },
];

/** The phase after each of the inputs, read from the state the machine returned. */
function phases(inputs: readonly Input[]): readonly string[] {
	const seen: string[] = [];
	let state = initialState(config());
	for (const input of inputs) {
		state = step(state, input).state;
		seen.push(phaseOf(state));
	}
	return seen;
}

/** The state after each of the inputs, with the phase and the log's last word. */
function walk(inputs: readonly Input[]): readonly { phase: string; tail: string }[] {
	const seen: { phase: string; tail: string }[] = [];
	let state = initialState(config());
	for (const input of inputs) {
		state = step(state, input).state;
		const tail = state.entries[state.entries.length - 1];
		seen.push({ phase: phaseOf(state), tail: tail === undefined ? "none" : tail.kind });
	}
	return seen;
}

function answer(callId: string): Input {
	return {
		kind: "tool_result",
		result: toolResultMessage(callId, "read_file", [{ type: "text", text: "contents" }], false),
	};
}

describe("the phase is derived, never stored", () => {
	test("the phase is an accessor on the state, not a value", () => {
		const state = initialState(config());
		const descriptor = Object.getOwnPropertyDescriptor(state, "phase");

		// A stored phase is a phase that can disagree with the state it belongs to.
		expect(descriptor?.value).toBeUndefined();
		expect(typeof descriptor?.get).toBe("function");
		expect(state.phase).toBe(phaseOf(state));
	});

	test("the phase is a function of the state, not of the object", () => {
		const state = step(initialState(config()), { kind: "prompt", message: userMessage("go") }).state;

		// A copy of the state holds the same things, so it names the same phase.
		expect(phaseOf({ ...state })).toBe(phaseOf(state));
		expect(phaseOf(state)).toBe("requesting");
		// The state it was copied from has not moved.
		expect(phaseOf(initialState(config()))).toBe("idle");
	});

	test("the phase of every state the machine returns is derived, not carried", () => {
		let state = initialState(config());
		for (const input of [
			{ kind: "prompt", message: userMessage("go") },
			{ kind: "provider", event: { type: "text_delta", delta: "looking" } },
			{ kind: "provider", event: { type: "done", stopReason: "stop", usage } },
		] as Input[]) {
			state = step(state, input).state;
			const descriptor = Object.getOwnPropertyDescriptor(state, "phase");
			expect(descriptor?.value).toBeUndefined();
			expect(typeof descriptor?.get).toBe("function");
		}
	});
});

describe("the phase names what the run is doing", () => {
	test("the phase follows the run from the first prompt to the end", () => {
		const seen = phases([
			{ kind: "prompt", message: userMessage("read a.txt") },
			{ kind: "provider", event: { type: "text_delta", delta: "looking" } },
			...asks.map((event) => ({ kind: "provider", event }) as Input),
			answer("c1"),
			answer("c2"),
			{ kind: "provider", event: { type: "done", stopReason: "stop", usage } },
		]);

		expect(seen).toEqual([
			"requesting", // the prompt is in the log and the provider is asked
			"streaming", // the provider is answering: the message is being written
			"streaming",
			"streaming",
			"streaming",
			"streaming",
			"dispatching", // the model asked for two tools: the batch is in flight
			"dispatching", // one answer of two: the batch is still in flight
			"requesting", // the batch closed and the run asks for another turn
			"finished", // the turn ended and the run had nothing left to do
		]);
	});

	test("the phase before the first prompt is idle", () => {
		expect(phaseOf(initialState(config()))).toBe("idle");
	});

	test("the phase agrees with the log it was read from", () => {
		const seen = walk([
			{ kind: "prompt", message: userMessage("read a.txt") },
			{ kind: "provider", event: { type: "text_delta", delta: "looking" } },
			...asks.map((event) => ({ kind: "provider", event }) as Input),
			answer("c1"),
			answer("c2"),
			{ kind: "provider", event: { type: "done", stopReason: "stop", usage } },
		]);

		// Each phase with the last word of the log it belongs to.
		expect(seen).toEqual([
			{ phase: "requesting", tail: "message" }, // the prompt is in the log
			{ phase: "streaming", tail: "message" },
			{ phase: "streaming", tail: "message" },
			{ phase: "streaming", tail: "message" },
			{ phase: "streaming", tail: "message" },
			{ phase: "streaming", tail: "message" },
			{ phase: "dispatching", tail: "tool_call" }, // the calls are in the log
			{ phase: "dispatching", tail: "tool_call" },
			{ phase: "requesting", tail: "tool_result" }, // the answers are in the log
			{ phase: "finished", tail: "message" }, // the model's last word is in the log
		]);
	});

	test("the phase of a turn that is closing is settling", () => {
		// The turn is over: the answers are in the log and nothing waits. The state
		// the machine holds between the answers and the next turn.
		const entry: JournalEntry = {
			kind: "message",
			role: "assistant",
			content: [],
			usage,
			stopReason: "stop",
			seq: 1,
			version: 1,
		};
		const state: RunState = {
			...initialState(config()),
			entries: [entry],
			turn: 1,
			answered: 1,
		};
		expect(phaseOf(state)).toBe("settling");
	});

	test("the phase of a cancelled run is finished", () => {
		const seen = phases([
			{ kind: "prompt", message: userMessage("read a.txt") },
			{ kind: "provider", event: { type: "text_delta", delta: "looking" } },
			{ kind: "cancel" },
		]);
		expect(seen[2]).toBe("finished");
	});

	test("the phase of a run that never started is finished", () => {
		// A run that is cancelled before the first prompt has asked nobody anything.
		expect(phases([{ kind: "cancel" }])[0]).toBe("finished");
	});

	test("the phase of a run the provider failed in is finished", () => {
		const seen = phases([
			{ kind: "prompt", message: userMessage("read a.txt") },
			{ kind: "provider", event: { type: "error", message: "the provider is down" } },
		]);
		expect(seen[1]).toBe("finished");
	});

	test("the phase of a run that spent its turn limit is finished", () => {
		let state = initialState(config(1));
		state = step(state, { kind: "prompt", message: userMessage("read a.txt") }).state;
		for (const event of asks) {
			state = step(state, { kind: "provider", event }).state;
		}
		expect(phaseOf(state)).toBe("dispatching");
		state = step(state, answer("c1")).state;
		state = step(state, answer("c2")).state;
		// The limit is spent: the run ends instead of asking for another turn.
		expect(phaseOf(state)).toBe("finished");
	});

	test("the phase of a batch the host refused is dispatching until it closes", () => {
		let state = initialState(config());
		state = step(state, { kind: "prompt", message: userMessage("read a.txt") }).state;
		for (const event of asks) {
			state = step(state, { kind: "provider", event }).state;
		}
		expect(phaseOf(state)).toBe("dispatching");
		// The host refuses one call of the batch: the batch is still in flight.
		state = step(state, {
			kind: "blocked",
			call: { type: "toolCall", id: "c1", name: "read_file", argumentsText: '{"path":"a.txt"}' },
			reason: "not this one",
		}).state;
		expect(phaseOf(state)).toBe("dispatching");
		state = step(state, answer("c2")).state;
		// The batch closed: the run asks for another turn.
		expect(phaseOf(state)).toBe("requesting");
	});

	test("the phase does not move when the host folds the log", () => {
		let state = initialState(config());
		state = step(state, { kind: "prompt", message: userMessage("read a.txt") }).state;
		for (const event of asks) {
			state = step(state, { kind: "provider", event }).state;
		}
		expect(phaseOf(state)).toBe("dispatching");
		// A compaction is a fold of the log, not a step of the run.
		state = step(state, { kind: "compact", firstKeptSeq: 1, summary: "the beginning" }).state;
		expect(phaseOf(state)).toBe("dispatching");
	});

	test("the phase does not move when the run is asked something else", () => {
		// A user message that arrives while the agent is working waits its turn.
		const seen = phases([
			{ kind: "prompt", message: userMessage("read a.txt") },
			{ kind: "provider", event: { type: "text_delta", delta: "looking" } },
			{ kind: "steer", message: userMessage("and this") },
		]);
		expect(seen[2]).toBe("streaming");
	});
});

describe("the driver reads the derived phase", () => {
	/** A provider that replays a script, one turn at a time. */
	function scripted(script: readonly (readonly ProviderEvent[])[]): HarnessHost["callProvider"] {
		let turn = 0;
		return async function* callProvider() {
			for (const event of script[turn] ?? []) yield event;
			turn += 1;
		};
	}

	async function collect(run: ReturnType<typeof runAgent>) {
		const events: AgentEvent[] = [];
		for await (const event of run) events.push(event);
		return { events, outcome: await run.result() };
	}

	test("the run ends when the derived phase says it is over", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			asks,
			[{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "stop", usage }],
		];
		const run = runAgent(config(), { callProvider: scripted(script) }, {
			message: userMessage("read a.txt"),
		});
		const { events, outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		const kinds = events.map((event) => event.type);
		expect(kinds[0]).toBe("agent_start");
		expect(kinds[kinds.length - 1]).toBe("agent_end");
		// The events keep their order: a turn starts, it ends, and the run ends.
		expect(kinds.indexOf("turn_start")).toBeLessThan(kinds.indexOf("turn_end"));
		expect(kinds.indexOf("turn_end")).toBeLessThan(kinds.indexOf("agent_end"));
	});

	test("every call of the batch still gets exactly one answer", async () => {
		// The pairing is what the "dispatching" phase guards: if the phase is wrong,
		// the answers are dropped and the transcript holds a call with no result.
		let state = initialState(config());
		state = step(state, { kind: "prompt", message: userMessage("read a.txt") }).state;
		for (const event of asks) {
			state = step(state, { kind: "provider", event }).state;
		}
		expect(phaseOf(state)).toBe("dispatching");
		state = step(state, answer("c1")).state;
		state = step(state, answer("c2")).state;

		const answers = state.entries.filter((entry) => entry.kind === "tool_result");
		expect(answers).toHaveLength(2);
		expect(answers.map((entry) => (entry.kind === "tool_result" ? entry.callId : ""))).toEqual([
			"c1",
			"c2",
		]);
	});

	test("a run the provider left open is closed by the driver", async () => {
		// The provider streamed a message and never said `done`: the machine has no
		// more work, and the phase is not `finished`. The driver reads the phase and
		// closes the run, so the run ends instead of hanging.
		const script: readonly (readonly ProviderEvent[])[] = [[{ type: "text_delta", delta: "half" }]];
		const run = runAgent(config(), { callProvider: scripted(script) }, {
			message: userMessage("read a.txt"),
		});
		const { events, outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "cancelled" });
		expect(events[events.length - 1]?.type).toBe("agent_end");
	});
});
