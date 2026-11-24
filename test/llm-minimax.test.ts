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
function request(): ProviderRequest {
	return {
		model: "MiniMax-M3",
		system: "you are a test",
		messages: [userMessage("hi")],
		tools: [getWeather],
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
