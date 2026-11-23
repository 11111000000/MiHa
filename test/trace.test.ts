import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import type { AgentEvent, ProviderEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import { assistantMessage, emptyUsage, toolResultMessage, userMessage } from "../src/core/messages.ts";
import type { JournalEntry } from "../src/core/journal.ts";
import { CASSETTE_VERSION, record, replay, requestKey } from "../src/trace/cassette.ts";

/**
 * The provider's answers, scripted.
 *
 * The first turn asks for a file, the second reports what it found — the shape the
 * end-to-end tests use, so the cassette is exercised against a run that really
 * happens rather than against a toy.
 */
const TURN_ONE: readonly ProviderEvent[] = [
	{ type: "tool_call_start", id: "c1", name: "read_file" },
	{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
	{
		type: "done",
		stopReason: "toolUse",
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
	},
];

const TURN_TWO: readonly ProviderEvent[] = [
	{ type: "text_delta", delta: "It says hello." },
	{
		type: "done",
		stopReason: "stop",
		usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
	},
];

/** Every kind of provider event. The cassette holds these and nothing else. */
const PROVIDER_EVENTS: readonly string[] = [
	"text_delta",
	"reasoning_delta",
	"tool_call_start",
	"tool_arguments_delta",
	"error",
	"done",
];

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

function config(model = "test-model"): HarnessConfig {
	return {
		model,
		system: "you are a test",
		tools: toolRegistry([readFile]),
		turnLimit: 8,
	};
}

/** A provider that replays a script, and remembers what it was asked. */
function scriptedProvider(
	script: readonly (readonly ProviderEvent[])[],
	asked: ProviderRequest[] = [],
): HarnessHost["callProvider"] {
	let turn = 0;
	return async function* callProvider(request: ProviderRequest) {
		asked.push(request);
		const events = script[turn] ?? [];
		turn += 1;
		for (const event of events) yield event;
	};
}

/** Runs an agent and collects what it wrote. */
async function runWith(
	provider: HarnessHost["callProvider"],
	prompt = "what is in a.txt?",
): Promise<{ readonly entries: readonly JournalEntry[]; readonly events: readonly AgentEvent[] }> {
	const entries: JournalEntry[] = [];
	const events: AgentEvent[] = [];
	const run = runAgent(
		config(),
		{ callProvider: provider, append: (entry) => entries.push(entry) },
		{ message: userMessage(prompt) },
	);
	for await (const event of run) events.push(event);
	await run.result();
	return { entries, events };
}

/** A request as the harness builds it, with the parts a test wants to change. */
/** A tool that differs only in its name — the question the provider is asked. */
function tool(name: string): ToolDefinition {
	return {
		name,
		description: "reads a file",
		parameters: { kind: "object", properties: { path: { kind: "string" } }, required: ["path"] },
		execute: async () => ({ content: [] }),
	};
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
	return {
		model: "test-model",
		system: "you are a test",
		messages: [userMessage("what is in a.txt?")],
		tools: [
			{
				name: "read_file",
				description: "reads a file",
				parameters: {
					kind: "object",
					properties: { path: { kind: "string" } },
					required: ["path"],
				},
				execute: async () => ({ content: [] }),
			},
		],
		...overrides,
	};
}

/** The provider's events, as a replay gives them back. */
async function eventsOf(
	provider: HarnessHost["callProvider"],
	asked: ProviderRequest,
): Promise<readonly ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of provider(asked, new AbortController().signal)) events.push(event);
	return events;
}

describe("the key of a request", () => {
	test("the same request has the same key", () => {
		expect(requestKey(request())).toBe(requestKey(request()));
	});

	test("the key does not depend on how the tool's properties were written down", () => {
		const one = request({
			tools: [
				{
					name: "read_file",
					description: "reads a file",
					parameters: {
						kind: "object",
						properties: { path: { kind: "string" }, size: { kind: "number" } },
					},
					execute: async () => ({ content: [] }),
				},
			],
		});
		const two = request({
			tools: [
				{
					name: "read_file",
					description: "reads a file",
					parameters: {
						kind: "object",
						properties: { size: { kind: "number" }, path: { kind: "string" } },
					},
					execute: async () => ({ content: [] }),
				},
			],
		});
		expect(requestKey(one)).toBe(requestKey(two));
	});

	test("requests that differ in what the provider is asked have different keys", () => {
		const base = requestKey(request());

		expect(requestKey(request({ model: "another-model" }))).not.toBe(base);
		expect(requestKey(request({ system: "you are another test" }))).not.toBe(base);
		expect(requestKey(request({ messages: [userMessage("what is in b.txt?")] }))).not.toBe(base);
		expect(
			requestKey(
				request({
					tools: [
						{
							name: "read_file",
							description: "reads a file, badly",
							parameters: {
								kind: "object",
								properties: { path: { kind: "string" } },
								required: ["path"],
							},
							execute: async () => ({ content: [] }),
						},
					],
				}),
			),
		).not.toBe(base);
		expect(
			requestKey(
				request({
					tools: [
						{
							name: "read_file",
							description: "reads a file",
							parameters: {
								kind: "object",
								properties: { path: { kind: "string" } },
								required: ["path", "size"],
							},
							execute: async () => ({ content: [] }),
						},
					],
				}),
			),
		).not.toBe(base);
	});

	test("the key covers what the provider is asked", () => {
		// The options reach the provider, so they reach the key.
		expect(requestKey(request({ options: { temperature: 0 } }))).not.toBe(
			requestKey(request({ options: { temperature: 1 } })),
		);

		// The flag of an answer reaches the provider, so it reaches the key.
		const answered = request({
			messages: [toolResultMessage("c1", "read_file", [{ type: "text", text: "contents" }], false)],
		});
		const failed = request({
			messages: [toolResultMessage("c1", "read_file", [{ type: "text", text: "contents" }], true)],
		});
		expect(requestKey(answered)).not.toBe(requestKey(failed));

		// What the assistant said reaches the provider, so it reaches the key.
		const said = request({
			messages: [assistantMessage([{ type: "text", text: "hello" }], "stop")],
		});
		const saidElse = request({
			messages: [assistantMessage([{ type: "text", text: "goodbye" }], "stop")],
		});
		expect(requestKey(said)).not.toBe(requestKey(saidElse));
	});

	test("the key does not cover what the provider answered, nor what the interface showed", () => {
		const said = request({
			messages: [assistantMessage([{ type: "text", text: "hello" }], "stop")],
		});
		// The usage and the stop reason are the provider's answer, not the question.
		const used = request({
			messages: [
				assistantMessage(
					[{ type: "text", text: "hello" }],
					"stop",
					{ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
				),
			],
		});
		const cut = request({
			messages: [assistantMessage([{ type: "text", text: "hello" }], "length")],
		});
		expect(requestKey(said)).toBe(requestKey(used));
		expect(requestKey(said)).toBe(requestKey(cut));

		// The details are the interface's business.
		const answered = request({
			messages: [toolResultMessage("c1", "read_file", [{ type: "text", text: "contents" }], false)],
		});
		const detailed = request({
			messages: [
				toolResultMessage("c1", "read_file", [{ type: "text", text: "contents" }], false, { rows: 3 }),
			],
		});
		expect(requestKey(answered)).toBe(requestKey(detailed));
	});
});

describe("the cassette", () => {
	test("a recorded run replays to the same journal", async () => {
		const asked: ProviderRequest[] = [];
		const recorder = record(scriptedProvider([TURN_ONE, TURN_TWO], asked));
		const recorded = await runWith(recorder.callProvider);

		const replayed = await runWith(replay(recorder.cassette).callProvider);

		expect(replayed.entries).toEqual(recorded.entries);
		expect(replayed.entries.length).toBeGreaterThan(0);
	});

	test("the replay answers with the recorded events", async () => {
		const asked: ProviderRequest[] = [];
		const recorder = record(scriptedProvider([TURN_ONE, TURN_TWO], asked));
		await runWith(recorder.callProvider);

		const first = asked[0];
		if (!first) throw new Error("the provider was not asked");

		const events = await eventsOf(replay(recorder.cassette).callProvider, first);
		expect(events).toEqual(TURN_ONE);
	});

	test("the recording holds the provider's responses and nothing else", async () => {
		const recorder = record(scriptedProvider([TURN_ONE, TURN_TWO]));
		await runWith(recorder.callProvider);
		const cassette = recorder.cassette;

		// The journal holds the run: the prompt, the system prompt and the tool are
		// all in it. The cassette holds the provider's answers, so it holds none of
		// them — and no part of the request either.
		const json = JSON.stringify(cassette);
		expect(json).not.toContain("what is in a.txt?");
		expect(json).not.toContain("you are a test");
		expect(json).not.toContain("reads a file");
		expect(json).not.toContain("test-model");

		// Every recorded item is a provider event, and there is nothing beside them.
		for (const recorded of Object.values(cassette.responses)) {
			for (const events of recorded) {
				for (const event of events) expect(PROVIDER_EVENTS).toContain(event.type);
			}
		}
		expect(Object.keys(cassette.responses)).toHaveLength(2);
	});

	test("the cassette is plain data", async () => {
		const recorder = record(scriptedProvider([TURN_ONE, TURN_TWO]));
		await runWith(recorder.callProvider);
		const cassette = recorder.cassette;

		const round = JSON.parse(JSON.stringify(cassette)) as typeof cassette;
		expect(round).toEqual(cassette);
	});
});

describe("a diverging run", () => {
	test("a request the recording does not hold is reported, not answered", async () => {
		const recorder = record(scriptedProvider([TURN_ONE, TURN_TWO]));
		await runWith(recorder.callProvider);

		const diverged = replay(recorder.cassette);
		const asked = request({ messages: [userMessage("what is in b.txt?")] });
		const events = await eventsOf(diverged.callProvider, asked);

		// Never an empty stream: a request the recording does not hold is an answer
		// the cassette cannot give, and the run must be told.
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("error");
		expect(diverged.divergences).toHaveLength(1);
	});

	test("the divergence names the request that differs", async () => {
		const recorder = record(scriptedProvider([TURN_ONE, TURN_TWO]));
		await runWith(recorder.callProvider);

		const diverged = replay(recorder.cassette);
		const { events } = await runWith(diverged.callProvider, "what is in b.txt?");

		const divergence = diverged.divergences[0];
		if (!divergence) throw new Error("no divergence");
		expect(diverged.divergences).toHaveLength(1);
		// The key of the request that differs is not a key the recording holds.
		expect(Object.keys(recorder.cassette.responses)).not.toContain(divergence.key);

		// And the divergence says which request it was, in words.
		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const assistant = end.messages.find((message) => message.role === "assistant");
		if (!assistant || assistant.role !== "assistant") throw new Error("no assistant message");
		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toContain(divergence.key);
		expect(assistant.errorMessage).toContain("what is in b.txt?");
	});
	test("a number and its name are different requests", () => {
		const base = request({ options: { weight: 1 } });
		expect(requestKey({ ...base, options: { weight: 1 } })).not.toBe(
			requestKey({ ...base, options: { weight: "1" } }),
		);
		expect(requestKey({ ...base, options: { weight: Number.NaN } })).not.toBe(
			requestKey({ ...base, options: { weight: "NaN" } }),
		);
		expect(requestKey({ ...base, options: { weight: Number.POSITIVE_INFINITY } })).not.toBe(
			requestKey({ ...base, options: { weight: "Infinity" } }),
		);
	});

	test("the key covers everything the provider is asked", () => {
		const base = request({});
		const variants = [
			{ ...base, model: "other" },
			{ ...base, system: "other" },
			{ ...base, tools: [tool("other")] },
			{ ...base, tools: [tool("a"), tool("b")] },
		];
		for (const variant of variants) {
			expect(requestKey(variant)).not.toBe(requestKey(base));
		}
		// The order of the tools is part of the question: two requests that ask for
		// the same tools in a different order are not the same request.
		expect(requestKey({ ...base, tools: [tool("b"), tool("a")] })).not.toBe(
			requestKey({ ...base, tools: [tool("a"), tool("b")] }),
		);
	});

	test("the key tells the messages apart", () => {
		const base = request({});
		const toolResult = (over: Partial<{ callId: string; name: string; text: string }>): ProviderRequest => ({
			...base,
			messages: [
				{
					role: "toolResult",
					toolCallId: over.callId ?? "c1",
					toolName: over.name ?? "read_file",
					content: [{ type: "text", text: over.text ?? "contents" }],
					isError: false,
				},
			],
		});
		expect(requestKey(toolResult({}))).not.toBe(requestKey(toolResult({ callId: "c2" })));
		expect(requestKey(toolResult({}))).not.toBe(requestKey(toolResult({ name: "other" })));
		expect(requestKey(toolResult({}))).not.toBe(requestKey(toolResult({ text: "other" })));
		// A user message and an assistant message that say the same thing are not the
		// same question.
		expect(requestKey({ ...base, messages: [{ role: "user", content: "same" }] })).not.toBe(
			requestKey({
				...base,
				messages: [{ role: "assistant", content: [{ type: "text", text: "same" }], usage: emptyUsage, stopReason: "stop" }],
			}),
		);
	});

	test("a broken stream leaves no recording", async () => {
		const recorder = record(async function* () {
			yield { type: "text_delta", delta: "partial" } as ProviderEvent;
			throw new Error("the provider broke");
		});
		try {
			for await (const _event of recorder.callProvider(request({}), new AbortController().signal)) {
				// drain
			}
		} catch {
			// the break is expected
		}
		expect(Object.keys(recorder.cassette.responses)).toHaveLength(0);
	});

	test("a cassette of another version is not answered", async () => {
		const recorder = record(scriptedProvider([TURN_ONE]));
		const cassette = recorder.cassette;
		const other = { ...cassette, version: 999 };
		const replayed = replay(other);
		const events: ProviderEvent[] = [];
		for await (const event of replayed.callProvider(request({}), new AbortController().signal)) {
			events.push(event);
		}
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("error");
		expect(replayed.divergences).toHaveLength(1);
		expect(replayed.divergences[0]?.reason).toContain("999");
	});

	test("the divergence carries the request that diverged", async () => {
		const recorder = record(scriptedProvider([TURN_ONE]));
		const replayed = replay(recorder.cassette);
		const asked = request({ model: "other" });
		for await (const _event of replayed.callProvider(asked, new AbortController().signal)) {
			// drain
		}
		expect(replayed.divergences[0]?.request).toEqual(asked);
	});

	test("two runs recorded under the same key each replay to their own journal", async () => {
		const asked = request({});
		const first = record(scriptedProvider([TURN_ONE]));
		const second = record(scriptedProvider([TURN_TWO]));
		for (const recorder of [first, second]) {
			for await (const _event of recorder.callProvider(asked, new AbortController().signal)) {
				// drain
			}
		}
		// One key, two answers: the first ask takes the first recording, the second
		// the second — so each run replays to its own journal.
		const key = requestKey(asked);
		expect(first.cassette.responses[key]).toHaveLength(1);
		expect(second.cassette.responses[key]).toHaveLength(1);

		const merged = {
			version: CASSETTE_VERSION,
			responses: { [key]: [...first.cassette.responses[key] ?? [], ...second.cassette.responses[key] ?? []] },
		};
		const replayed = replay(merged);
		const firstAsk: ProviderEvent[] = [];
		for await (const event of replayed.callProvider(asked, new AbortController().signal)) {
			firstAsk.push(event);
		}
		const secondAsk: ProviderEvent[] = [];
		for await (const event of replayed.callProvider(asked, new AbortController().signal)) {
			secondAsk.push(event);
		}
		expect(firstAsk).toEqual([...(first.cassette.responses[key] ?? [])[0] ?? []]);
		expect(secondAsk).toEqual([...(second.cassette.responses[key] ?? [])[0] ?? []]);
		expect(replayed.divergences).toHaveLength(0);
	});
});
