import { describe, expect, test } from "bun:test";
import { readSseData } from "../src/llm/sse.ts";
import { ToolCallTracker } from "../src/llm/tool-calls.ts";
import { openaiCompat, toWireMessages, toWireTools } from "../src/llm/openai-compat.ts";
import type { ProviderEvent } from "../src/core/events.ts";
import type { ProviderRequest } from "../src/core/run.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import { assistantMessage, toolCall, toolResultMessage, userMessage } from "../src/core/messages.ts";

function chunkStream(body: string): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			yield new TextEncoder().encode(body);
		},
	};
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

const readFile: ToolDefinition = {
	name: "read_file",
	description: "reads a file",
	parameters: {
		kind: "object",
		properties: { path: { kind: "string" } },
		required: ["path"],
		additional: false,
	},
	execute: async () => ({ content: [] }),
};

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
	return {
		model: "gpt-x",
		system: "you are a test",
		messages: [userMessage("read a.txt")],
		tools: [readFile],
		...overrides,
	};
}

describe("the SSE reader", () => {
	test("reads the data of a record", async () => {
		const events = [];
		for await (const data of readSseData(chunkStream("data: one\n\ndata: two\n\n"))) events.push(data);
		expect(events).toEqual(["one", "two"]);
	});

	test("a record whose data spans several lines joins them", async () => {
		const events = [];
		for await (const data of readSseData(chunkStream("data: a\ndata: b\n\n"))) events.push(data);
		expect(events).toEqual(["a\nb"]);
	});

	test("the last record may arrive without a trailing newline", async () => {
		const events = [];
		for await (const data of readSseData(chunkStream("data: last"))) events.push(data);
		expect(events).toEqual(["last"]);
	});

	test("a comment is not data", async () => {
		const events = [];
		for await (const data of readSseData(chunkStream(": a ping\n\ndata: real\n\n"))) events.push(data);
		expect(events).toEqual(["real"]);
	});

	test("chunks may split a record anywhere", async () => {
		const events = [];
		const stream = {
			async *[Symbol.asyncIterator]() {
				yield new TextEncoder().encode("da");
				yield new TextEncoder().encode("ta: sp");
				yield new TextEncoder().encode("lit\n\n");
			},
		};
		for await (const data of readSseData(stream)) events.push(data);
		expect(events).toEqual(["split"]);
	});
});

describe("the tool-call tracker", () => {
	test("a call starts once and carries every fragment in order", () => {
		const tracker = new ToolCallTracker();
		const events = [
			...tracker.feed({ index: 0, id: "c1", name: "read_file", argumentsDelta: '{"pa' }),
			...tracker.feed({ index: 0, argumentsDelta: 'th":"a"}' }),
		];
		expect(events).toEqual([
			{ type: "tool_call_start", id: "c1", name: "read_file" },
			{ type: "tool_arguments_delta", id: "c1", delta: '{"pa' },
			{ type: "tool_arguments_delta", id: "c1", delta: 'th":"a"}' },
		]);
		expect(tracker.calls).toEqual([
			{ id: "c1", name: "read_file", argumentsText: '{"path":"a"}' },
		]);
	});

	test("parallel calls are correlated by index, not by arrival", () => {
		const tracker = new ToolCallTracker();
		const events = [
			...tracker.feed({ index: 0, id: "c1", name: "read_file", argumentsDelta: '{"a' }),
			...tracker.feed({ index: 1, id: "c2", name: "list_dir", argumentsDelta: '{"b' }),
			...tracker.feed({ index: 0, argumentsDelta: '":1}' }),
			...tracker.feed({ index: 1, argumentsDelta: '":2}' }),
		];
		const deltas = events.filter((event) => event.type === "tool_arguments_delta");
		expect(deltas).toEqual([
			{ type: "tool_arguments_delta", id: "c1", delta: '{"a' },
			{ type: "tool_arguments_delta", id: "c2", delta: '{"b' },
			{ type: "tool_arguments_delta", id: "c1", delta: '":1}' },
			{ type: "tool_arguments_delta", id: "c2", delta: '":2}' },
		]);
		expect(tracker.calls.map((call) => call.argumentsText)).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("a call whose id arrives late still starts once and carries every fragment", () => {
		const tracker = new ToolCallTracker();
		const events = [
			...tracker.feed({ index: 0, argumentsDelta: '{"a' }),
			...tracker.feed({ index: 0, id: "c1", name: "read_file" }),
			...tracker.feed({ index: 0, argumentsDelta: '":1}' }),
		];
		expect(events.filter((event) => event.type === "tool_call_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "tool_arguments_delta")).toHaveLength(2);
		expect(tracker.calls).toEqual([
			{ id: "c1", name: "read_file", argumentsText: '{"a":1}' },
		]);
	});
});

describe("the adapter never throws", () => {
	test("a network failure arrives as an error event", async () => {
		const provider = openaiCompat({
			baseUrl: "http://provider.invalid/v1",
			fetch: async () => {
				throw new Error("the socket is closed");
			},
		});
		const events = await collect(provider(request(), new AbortController().signal));
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("error");
	});

	test("a refusal arrives as an error event", async () => {
		const provider = openaiCompat({
			baseUrl: "http://provider.invalid/v1",
			fetch: async () => ({ ok: false, status: 429, body: null }),
		});
		const events = await collect(provider(request(), new AbortController().signal));
		const failure = events.find((event) => event.type === "error");
		if (failure?.type !== "error") throw new Error("no error event");
		expect(failure.message).toContain("429");
	});

	test("a malformed chunk arrives as an error event", async () => {
		const provider = openaiCompat({
			baseUrl: "http://provider.invalid/v1",
			fetch: async () => ({ ok: true, status: 200, body: chunkStream("data: {not json\n\ndata: [DONE]\n\n") }),
		});
		const events = await collect(provider(request(), new AbortController().signal));
		expect(events[0]?.type).toBe("error");
	});

	test("a stream that ends without a terminal event arrives as an error event", async () => {
		const provider = openaiCompat({
			baseUrl: "http://provider.invalid/v1",
			fetch: async () => ({
				ok: true,
				status: 200,
				body: chunkStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
			}),
		});
		const events = await collect(provider(request(), new AbortController().signal));
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({ type: "text_delta", delta: "hi" });
		const failure = events.find((event) => event.type === "error");
		if (failure?.type !== "error") throw new Error("no error event");
		expect(failure.message).toContain("without a terminal event");
	});
});

describe("the adapter lowers the request", () => {
	test("a complete stream becomes the core's events", async () => {
		const body = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}',
			"",
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}',
			"",
			'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"input":11,"output":3}}',
			"",
			"data: [DONE]",
			"",
		].join("\n");

		const provider = openaiCompat({
			baseUrl: "http://provider.invalid/v1",
			fetch: async () => ({ ok: true, status: 200, body: chunkStream(body) }),
		});
		const events = await collect(provider(request(), new AbortController().signal));

		expect(events).toEqual([
			{ type: "text_delta", delta: "Hello" },
			{ type: "tool_call_start", id: "c1", name: "read_file" },
			{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a"}' },
			{ type: "done", stopReason: "toolUse", usage: { input: 11, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
		]);
	});

	test("the messages reach the wire in the provider's shape", () => {
		const messages = [
			userMessage("read a.txt"),
			assistantMessage(
				[
					{ type: "text", text: "looking" },
					toolCall("c1", "read_file", '{"path":"a.txt"}'),
				],
				"toolUse",
			),
			toolResultMessage("c1", "read_file", [{ type: "text", text: "contents" }], false),
		];

		expect(toWireMessages(messages)).toEqual([
			{ role: "user", content: "read a.txt" },
			{
				role: "assistant",
				content: "looking",
				tool_calls: [
					{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
				],
			},
			{ role: "tool", tool_call_id: "c1", content: "contents" },
		]);
	});

	test("the tools reach the wire with the dialect's JSON Schema", () => {
		expect(toWireTools([readFile])).toEqual([
			{
				type: "function",
				function: {
					name: "read_file",
					description: "reads a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
						additionalProperties: false,
					},
				},
			},
		]);
	});

	test("the options bag reaches the wire untouched", async () => {
		let sent: { body: string } | undefined;
		const provider = openaiCompat({
			baseUrl: "http://provider.invalid/v1",
			fetch: async (_url, init) => {
				sent = { body: String(init.body) };
				return { ok: true, status: 200, body: chunkStream("data: [DONE]\n\n") };
			},
		});
		await collect(provider(request({ options: { temperature: 0.2 } }), new AbortController().signal));
		expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ temperature: 0.2, stream: true });
	});
});

describe("the registry of tools is what the adapter sees", () => {
	test("the adapter is handed the tool definitions of the request", () => {
		expect(toWireTools([...toolRegistry([readFile]).values()])).toHaveLength(1);
	});
});
