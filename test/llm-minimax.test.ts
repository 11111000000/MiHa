/**
 * MiniMax-M3 on the OpenAI-compatible path.
 *
 * The fixtures are real captures: the bytes MiniMax sent on 2026-11-24 for a
 * streamed chat completion with `thinking: { type: "adaptive" }`,
 * `reasoning_split: true` and `stream_options: { include_usage: true }`. They hold
 * the provider's answers and nothing else — no key, no account data.
 *
 * What the captures show, and what the adapter therefore has to survive:
 *
 * - **There is no `[DONE]`.** The stream ends after the usage record. An adapter
 *   that only accepts `data: [DONE]` as the end of a stream never finishes a
 *   MiniMax answer — it reports a stream that was cut short.
 * - **The usage is the standard spelling.** `prompt_tokens` and
 *   `completion_tokens`, with `completion_tokens_details.reasoning_tokens` and
 *   `prompt_tokens_details.cached_tokens` beside them. An adapter that reads
 *   `input` and `output` counts a MiniMax answer as free.
 * - **The last record has no choice.** It is `{"choices":[],"usage":{…}}`, so the
 *   usage arrives in a record the choice cannot be read from.
 * - **The thinking is a separate field only when it is asked for.** With
 *   `reasoning_split: true` the thinking arrives as `delta.reasoning_content`; the
 *   default puts it inside `delta.content`, wrapped in `<think>` tags.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openaiCompat, type ProviderFetch } from "../src/llm/openai-compat.ts";
import { readSseData } from "../src/llm/sse.ts";
import type { ProviderEvent } from "../src/core/events.ts";
import type { ProviderRequest } from "../src/core/run.ts";
import type { ToolDefinition } from "../src/core/tools.ts";
import { userMessage } from "../src/core/messages.ts";

/** The base URL the captures came from. */
const BASE_URL = "https://api.minimax.io/v1";

/** A capture, as it was received. */
function fixture(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/** The capture as a byte stream, the way a response body arrives. */
function bytes(body: string): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			yield new TextEncoder().encode(body);
		},
	};
}

/** A fetch that answers with a capture instead of with a provider. */
function serving(body: string): ProviderFetch {
	return async () => ({ ok: true, status: 200, body: bytes(body) });
}

const getWeather: ToolDefinition = {
	name: "get_weather",
	description: "gets the weather of a city",
	parameters: {
		kind: "object",
		properties: { city: { kind: "string" } },
		required: ["city"],
		additional: false,
	},
	execute: async () => ({ content: [] }),
};

/** The request the captures answer. */
function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
	return {
		model: "MiniMax-M3",
		system: "you are a test",
		messages: [userMessage("hi")],
		tools: [getWeather],
		...overrides,
	};
}

/** What the adapter made of a capture. */
async function eventsOf(body: string): Promise<readonly ProviderEvent[]> {
	const provider = openaiCompat({
		baseUrl: BASE_URL,
		apiKey: undefined,
		fetch: serving(body),
	});
	const events: ProviderEvent[] = [];
	for await (const event of provider(request(), new AbortController().signal)) events.push(event);
	return events;
}

/**
 * The body the adapter put on the wire, and the events it made of the answer.
 *
 * The request is part of what the adapter does: what it asks for and what it
 * leaves out are decisions the model sees.
 */
async function callOf(
	body: string,
	overrides: Partial<ProviderRequest> = {},
): Promise<{ readonly sent: unknown; readonly events: readonly ProviderEvent[] }> {
	let sent: unknown;
	const provider = openaiCompat({
		baseUrl: BASE_URL,
		apiKey: undefined,
		fetch: async (_url, init) => {
			sent = JSON.parse(String(init.body));
			return { ok: true, status: 200, body: bytes(body) };
		},
	});
	const events: ProviderEvent[] = [];
	for await (const event of provider(request(overrides), new AbortController().signal)) events.push(event);
	return { sent, events };
}

/** A stream of records, as the wire sends them. */
function stream(...records: readonly string[]): string {
	return records.map((record) => `data: ${record}\n\n`).join("");
}

/** The records of a capture, as the SSE reader sees them. */
async function recordsOf(body: string): Promise<readonly string[]> {
	const records: string[] = [];
	for await (const record of readSseData(bytes(body))) records.push(record);
	return records;
}

/** The text of the deltas of one kind. */
function joined(events: readonly ProviderEvent[], type: "text_delta" | "reasoning_delta"): string {
	let text = "";
	for (const event of events) {
		if (event.type === "text_delta" || event.type === "reasoning_delta") {
			if (event.type === type) text += event.delta;
		}
	}
	return text;
}

/** How many deltas of one kind arrived. */
function count(events: readonly ProviderEvent[], type: "text_delta" | "reasoning_delta"): number {
	let total = 0;
	for (const event of events) {
		if (event.type === "text_delta" || event.type === "reasoning_delta") {
			if (event.type === type) total += 1;
		}
	}
	return total;
}

/** The ids of the calls that started, in the order they started. */
function startedIds(events: readonly ProviderEvent[]): readonly string[] {
	const ids: string[] = [];
	for (const event of events) {
		if (event.type === "tool_call_start") ids.push(event.id);
	}
	return ids;
}

/** The arguments of every call, gathered by the id the call was started with. */
function argumentsById(events: readonly ProviderEvent[]): ReadonlyMap<string, string> {
	const byId = new Map<string, string>();
	for (const event of events) {
		if (event.type === "tool_arguments_delta") {
			byId.set(event.id, `${byId.get(event.id) ?? ""}${event.delta}`);
		}
	}
	return byId;
}

/** The message of the first failure in a stream, if there is one. */
function failureOf(events: readonly ProviderEvent[]): string | undefined {
	for (const event of events) {
		if (event.type === "error") return event.message;
	}
	return undefined;
}

describe("the MiniMax capture", () => {
	test("the stream has no terminal marker", async () => {
		const records = await recordsOf(fixture("minimax-m3-stream.sse"));
		expect(records).toHaveLength(10);
		expect(records.some((record) => record.includes("[DONE]"))).toBe(false);
	});

	test("the last record carries the usage and no choice", async () => {
		const records = await recordsOf(fixture("minimax-m3-stream.sse"));
		const last = records[records.length - 1];
		expect(last).toContain('"choices":[]');
		expect(last).toContain("prompt_tokens");
	});
});

describe("the adapter against MiniMax", () => {
	test("the thinking arrives as a reasoning delta", async () => {
		const events = await eventsOf(fixture("minimax-m3-stream.sse"));

		expect(joined(events, "reasoning_delta")).toBe(
			'The user just said "hi". I should respond in a friendly, brief way. No tools needed. Just greet them and offer help.',
		);
		expect(count(events, "reasoning_delta")).toBe(5);
	});

	test("the text arrives", async () => {
		const events = await eventsOf(fixture("minimax-m3-stream.sse"));

		expect(joined(events, "text_delta")).toBe("Hi! How can I help you today?");
		// The first record of the stream carries an empty content; it is not a
		// delta of nothing.
		expect(count(events, "text_delta")).toBe(2);
	});

	test("the usage arrives", async () => {
		const events = await eventsOf(fixture("minimax-m3-stream.sse"));

		const done = events.find((event) => event.type === "done");
		if (!done || done.type !== "done") throw new Error("no done event");
		expect(done.usage).toEqual({
			input: 212,
			output: 40,
			cacheRead: 128,
			cacheWrite: 0,
			reasoning: 30,
		});
	});

	test("the stream that ends without a marker is a finished stream", async () => {
		const events = await eventsOf(fixture("minimax-m3-stream.sse"));

		expect(failureOf(events)).toBeUndefined();
		const done = events.find((event) => event.type === "done");
		if (!done || done.type !== "done") throw new Error("no done event");
		expect(done.stopReason).toBe("stop");
	});

	test("a tool call correlates by its index", async () => {
		const events = await eventsOf(fixture("minimax-m3-tool-call.sse"));

		const started = events.find((event) => event.type === "tool_call_start");
		if (!started || started.type !== "tool_call_start") throw new Error("no tool call");
		expect(started.name).toBe("get_weather");
		expect(started.id).toBe("call-077c5d47-a868-41e4-a388-8c21b7faaf7b");
		// The arguments arrive in four fragments; they are one argument string.
		expect(argumentsById(events).get(started.id)).toBe('{"city":"Beijing"}');
	});

	test("two calls in one message keep their own arguments", async () => {
		const events = await eventsOf(fixture("minimax-m3-two-tools.sse"));

		// Two calls, two ids, two indexes: the arguments of one are never the
		// arguments of the other.
		expect(startedIds(events)).toEqual([
			"call_gTgzn1l638OawEqFUEQjZbpZ",
			"call_WqOiX4jOI3CTh87ss7jaECAX",
		]);
		const arguments_ = argumentsById(events);
		expect(arguments_.get("call_gTgzn1l638OawEqFUEQjZbpZ")).toBe('{"city": "Beijing"}');
		expect(arguments_.get("call_WqOiX4jOI3CTh87ss7jaECAX")).toBe('{"city": "Oslo"}');
	});

	test("the text before the tool call arrives too", async () => {
		const events = await eventsOf(fixture("minimax-m3-tool-call.sse"));

		expect(joined(events, "text_delta")).toBe("I'll check the weather in Beijing for you.");
	});

	test("the usage of a tool call arrives, and the stop reason is the call", async () => {
		const events = await eventsOf(fixture("minimax-m3-tool-call.sse"));

		expect(failureOf(events)).toBeUndefined();
		const done = events.find((event) => event.type === "done");
		if (!done || done.type !== "done") throw new Error("no done event");
		expect(done.stopReason).toBe("toolUse");
		expect(done.usage).toEqual({
			input: 444,
			output: 38,
			cacheRead: 384,
			cacheWrite: 0,
			reasoning: 0,
		});
	});

	test("the usage arrives even when the stream ends without closing the last record", async () => {
		// The last record of a capture is the usage, and a stream may end right
		// after it — with no blank line to close the record.
		const events = await eventsOf(fixture("minimax-m3-stream.sse").trimEnd());

		expect(failureOf(events)).toBeUndefined();
		const done = events.find((event) => event.type === "done");
		if (!done || done.type !== "done") throw new Error("no done event");
		expect(done.usage.input).toBe(212);
	});

	test("a record that is not JSON is reported, and the adapter does not raise", async () => {
		const broken = fixture("minimax-m3-stream.sse").replace('data: {"id"', "data: {not json");
		let events: readonly ProviderEvent[] = [];
		let raised: unknown;
		try {
			events = await eventsOf(broken);
		} catch (error) {
			raised = error;
		}

		expect(raised).toBeUndefined();
		expect(failureOf(events)).toContain("not JSON");
	});

	test("the adapter never throws and never rejects", async () => {
		const events = await eventsOf(fixture("minimax-m3-stream.sse"));
		const other = await eventsOf(fixture("minimax-m3-tool-call.sse"));

		expect(events.length).toBeGreaterThan(0);
		expect(other.length).toBeGreaterThan(0);
		expect(failureOf(events)).toBeUndefined();
		expect(failureOf(other)).toBeUndefined();
	});
});

describe("the adapter against the wire", () => {
	test("a delta that is not a string is not a delta", async () => {
		// A gateway that sends `"content": null` sends no text. The string
		// "null" is not what it meant, and it must not reach the transcript.
		const body = stream(
			'{"choices":[{"delta":{"content":null}}]}',
			'{"choices":[{"delta":{"content":"hi"}}]}',
			'{"choices":[{"finish_reason":"stop"}]}',
		);

		const events = await eventsOf(body);

		expect(failureOf(events)).toBeUndefined();
		expect(joined(events, "text_delta")).toBe("hi");
		expect(count(events, "text_delta")).toBe(1);
	});

	test("a reasoning delta that is not a string is not a delta", async () => {
		const body = stream(
			'{"choices":[{"delta":{"reasoning_content":null}}]}',
			'{"choices":[{"delta":{"reasoning_content":"thought"}}]}',
			'{"choices":[{"finish_reason":"stop"}]}',
		);

		const events = await eventsOf(body);

		expect(joined(events, "reasoning_delta")).toBe("thought");
		expect(count(events, "reasoning_delta")).toBe(1);
	});

	test("a record that carries both the text and the thinking delivers both", async () => {
		const body = stream(
			'{"choices":[{"delta":{"content":"answer","reasoning_content":"thought"}}]}',
			'{"choices":[{"finish_reason":"stop"}]}',
		);

		const events = await eventsOf(body);

		expect(joined(events, "text_delta")).toBe("answer");
		expect(joined(events, "reasoning_delta")).toBe("thought");
	});

	test("a stream cut short by the token limit is reported as length", async () => {
		const body = stream(
			'{"choices":[{"delta":{"content":"partial"}}]}',
			'{"choices":[{"finish_reason":"length"}]}',
		);

		const events = await eventsOf(body);

		const done = events.find((event) => event.type === "done");
		if (!done || done.type !== "done") throw new Error("no done event");
		expect(done.stopReason).toBe("length");
	});

	test("the standard spelling of the usage wins over the fallback", async () => {
		const body = stream(
			'{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":3,"input":99,"output":88}}',
		);

		const events = await eventsOf(body);

		const done = events.find((event) => event.type === "done");
		if (!done || done.type !== "done") throw new Error("no done event");
		expect(done.usage.input).toBe(11);
		expect(done.usage.output).toBe(3);
	});

	test("the fallback spelling of the usage is still read", async () => {
		const body = stream('{"choices":[{"finish_reason":"stop"}],"usage":{"input":7,"output":4}}');

		const events = await eventsOf(body);

		const done = events.find((event) => event.type === "done");
		if (!done || done.type !== "done") throw new Error("no done event");
		expect(done.usage.input).toBe(7);
		expect(done.usage.output).toBe(4);
	});

	test("the counts of the first usage record survive the second", async () => {
		// A stream may report its usage more than once, and the second record
		// does not have to carry every count.
		const body = stream(
			'{"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"completion_tokens_details":{"reasoning_tokens":3}}}',
			'{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10}}',
		);

		const events = await eventsOf(body);

		const done = events.find((event) => event.type === "done");
		if (!done || done.type !== "done") throw new Error("no done event");
		expect(done.usage).toEqual({
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 3,
		});
	});

	test("two interleaved calls keep their own arguments", async () => {
		// The fragments of the two calls arrive one after the other: index 0,
		// index 1, index 0, index 1. Only the index says which call a fragment
		// belongs to — a tracker that correlates by arrival mixes them.
		const body = stream(
			'{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}',
			'{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}',
			'{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Beijing\\"}"}}]}}]}',
			'{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"Oslo\\"}"}}]}}]}',
			'{"choices":[{"finish_reason":"tool_calls"}]}',
		);

		const events = await eventsOf(body);

		expect(failureOf(events)).toBeUndefined();
		expect(startedIds(events)).toEqual(["c1", "c2"]);
		const arguments_ = argumentsById(events);
		expect(arguments_.get("c1")).toBe('{"city":"Beijing"}');
		expect(arguments_.get("c2")).toBe('{"city":"Oslo"}');
	});

	test("a tool call that never identifies itself is reported, not absorbed", async () => {
		// The call says what to call, but never which tool. It cannot be run,
		// and the model must be told: a call that vanishes is a call the model
		// waits for forever.
		const body = stream(
			'{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
			'{"choices":[{"finish_reason":"tool_calls"}]}',
		);

		const events = await eventsOf(body);

		expect(startedIds(events)).toEqual([]);
		expect(failureOf(events)).toContain("never identified itself");
		// And the stream is not reported as a finished answer.
		expect(events.some((event) => event.type === "done")).toBe(false);
	});

	test("the request asks the provider for the usage", async () => {
		const { sent } = await callOf(fixture("minimax-m3-stream.sse"));

		expect(sent).toMatchObject({ stream_options: { include_usage: true } });
	});

	test("the system prompt reaches the wire as the system message", async () => {
		const { sent } = await callOf(fixture("minimax-m3-stream.sse"));

		const body = sent as { readonly messages: readonly { readonly role: string; readonly content: string }[] };
		expect(body.messages[0]).toEqual({ role: "system", content: "you are a test" });
	});

	test("the options bag cannot replace the adapter's own fields", async () => {
		// The bag holds the provider's own knobs. It does not get to say which
		// model answers, what the model is told, or that there is no stream.
		const { sent } = await callOf(fixture("minimax-m3-stream.sse"), {
			options: {
				model: "hijacked",
				messages: [],
				tools: [],
				stream: false,
				temperature: 0.2,
			},
		});

		const body = sent as {
			readonly model: string;
			readonly messages: readonly unknown[];
			readonly tools: readonly unknown[];
			readonly stream: boolean;
			readonly temperature: number;
		};
		expect(body.model).toBe("MiniMax-M3");
		expect(body.stream).toBe(true);
		expect(body.messages.length).toBeGreaterThan(0);
		expect(body.tools.length).toBeGreaterThan(0);
		// The knob the host meant to turn is still turned.
		expect(body.temperature).toBe(0.2);
	});
});
