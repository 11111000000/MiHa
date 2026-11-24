/**
 * The OpenAI-compatible adapter.
 *
 * It lowers the core's flat request to the wire format of OpenAI-compatible chat
 * completions, and streams the provider's events back in the core's vocabulary.
 *
 * The adapter **never throws and never rejects** (ADR 0005 D24, law M4). A network
 * failure, a refusal, a malformed chunk and a stream that ends without a terminal
 * event all arrive as an error event. That is not politeness: the core's pairing
 * invariant says every tool call is answered, and a thrown exception from the
 * provider would leave a call unanswered in the transcript.
 *
 * A stream is finished when the provider says so: the `[DONE]` marker, or a chunk
 * that carries a finish reason. Not every provider sends the marker — MiniMax does
 * not — and a stream that says nothing about its ending was cut short.
 */

import { emptyUsage, type AgentMessage, type ContentBlock, type Usage } from "../core/messages.ts";
import type { ProviderEvent } from "../core/events.ts";
import type { ProviderRequest } from "../core/run.ts";
import { toJsonSchema } from "../schema/dialect.ts";
import type { ToolDefinition } from "../core/tools.ts";
import { readSseData } from "./sse.ts";
import { ToolCallTracker } from "./tool-calls.ts";

/** What the adapter needs from a response. Narrower than the DOM's `Response`. */
export interface ProviderResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly body: AsyncIterable<Uint8Array> | null;
}

export type ProviderFetch = (url: string, init: RequestInit) => Promise<ProviderResponse>;

export interface OpenAiCompatOptions {
	/** The base URL of the endpoint, without the path. */
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly headers?: Readonly<Record<string, string>>;
	/** Injected for tests, and for hosts with their own HTTP client. */
	readonly fetch?: ProviderFetch;
}

/** The seam: a provider turns the core's request into the core's events. */
export type ProviderFn = (
	request: ProviderRequest,
	signal: AbortSignal,
) => AsyncIterable<ProviderEvent>;

interface WireToolCall {
	readonly id: string;
	readonly type: "function";
	readonly function: { readonly name: string; readonly arguments: string };
}

interface WireMessage {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content: string | null;
	readonly tool_call_id?: string;
	readonly tool_calls?: readonly WireToolCall[];
}

/** One fragment of a tool call, as the wire sends it. */
interface WireToolCallDelta {
	readonly index?: number;
	readonly id?: string;
	readonly function?: { readonly name?: string; readonly arguments?: string };
}

/**
 * The delta of one assistant message, as the wire sends it.
 *
 * The fields are nullable because the wire says so: a gateway that sends
 * `"content": null` sends **no** content, and the adapter has to read that as
 * the absence of a delta rather than as the string "null".
 */
interface WireDelta {
	readonly content?: string | null;
	readonly reasoning_content?: string | null;
	readonly tool_calls?: readonly WireToolCallDelta[];
}

function textOf(content: readonly ContentBlock[]): string {
	let text = "";
	for (const block of content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

/**
 * Lowers the core's request to the wire format.
 *
 * The system prompt is the **first** message, the way the wire expects it: the
 * model's instructions are a message of their own, and a request that leaves
 * them out asks a question the host never asked.
 */
export function toWireMessages(
	system: string,
	messages: readonly AgentMessage[],
): readonly WireMessage[] {
	const wire: WireMessage[] = [];
	if (system !== "") {
		wire.push({ role: "system", content: system });
	}
	for (const message of messages) {
		switch (message.role) {
			case "user": {
				const content = typeof message.content === "string" ? message.content : textOf(message.content);
				wire.push({ role: "user", content });
				break;
			}
			case "assistant": {
				const content = textOf(message.content);
				const calls = message.content.filter(
					(block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall",
				);
				const toolCalls = calls.map((call) => ({
					id: call.id,
					type: "function" as const,
					function: { name: call.name, arguments: call.argumentsText },
				}));
				wire.push({
					role: "assistant",
					content: content.length > 0 ? content : null,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				});
				break;
			}
			case "toolResult": {
				wire.push({
					role: "tool",
					tool_call_id: message.toolCallId,
					content: textOf(message.content),
				});
				break;
			}
		}
	}
	return wire;
}

/** Lowers the tool definitions to the wire format, using our dialect's conversion. */
export function toWireTools(
	tools: readonly ToolDefinition[],
): readonly { type: "function"; function: { name: string; description: string; parameters: unknown } }[] {
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: toJsonSchema(tool.parameters),
		},
	}));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stopReasonOf(finishReason: unknown): "stop" | "length" | "toolUse" {
	if (finishReason === "length") return "length";
	if (finishReason === "tool_calls" || finishReason === "function_call") return "toolUse";
	return "stop";
}

/** The usage as the wire reports it. */
interface WireUsage {
	readonly input?: number;
	readonly output?: number;
	readonly prompt_tokens?: number;
	readonly completion_tokens?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly reasoning?: number;
	readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
	readonly prompt_tokens_details?: { readonly cached_tokens?: number };
}

/**
 * The usage as the core counts it, as far as the wire reports it.
 *
 * The OpenAI-compatible wire spells the counts `prompt_tokens` and
 * `completion_tokens` — MiniMax follows it — and some gateways spell them `input`
 * and `output` instead, so both are read and the standard spelling wins.
 *
 * The reasoning tokens are a **part** of the completion tokens, not an addition to
 * them: the wire counts them in `completion_tokens` and names them in
 * `completion_tokens_details.reasoning_tokens`. The cached prompt tokens are the
 * ones the provider read from its cache, which is what the core calls a cache
 * read.
 *
 * A count the record does not mention is **absent**, not zero: a record that says
 * nothing about the output does not say the output was zero.
 */
function usageOf(wire: WireUsage): Partial<Usage> {
	return {
		input: wire.prompt_tokens ?? wire.input,
		output: wire.completion_tokens ?? wire.output,
		cacheRead: wire.prompt_tokens_details?.cached_tokens ?? wire.cacheRead,
		cacheWrite: wire.cacheWrite,
		reasoning: wire.completion_tokens_details?.reasoning_tokens ?? wire.reasoning,
	};
}

/**
 * The usage of the turn so far.
 *
 * A stream may report its usage more than once, and a later record does not
 * have to carry every count: a record that mentions only the prompt leaves the
 * output and the reasoning as they were. Within one turn the counts only grow,
 * so the largest report of each count is the truest one.
 */
function mergeUsage(current: Usage, addition: Partial<Usage>): Usage {
	return {
		input: larger(current.input, addition.input),
		output: larger(current.output, addition.output),
		cacheRead: larger(current.cacheRead, addition.cacheRead),
		cacheWrite: larger(current.cacheWrite, addition.cacheWrite),
		reasoning: larger(current.reasoning, addition.reasoning),
	};
}

/** The larger of two counts, where an absent count says nothing. */
function larger(current: number, addition: number | undefined): number {
	return addition === undefined ? current : Math.max(current, addition);
}

/**
 * Creates an OpenAI-compatible provider.
 *
 * The options bag of the request is passed through to the wire verbatim, so a host
 * can reach a provider knob MiHa has never heard of. It is spread **before** the
 * adapter's own fields: the bag holds the provider's knobs (`temperature`,
 * `max_completion_tokens`, MiniMax's `thinking` and `reasoning_split`), and it does
 * not get to say which model answers, what the model is told, or that there is no
 * stream at all.
 */
export function openaiCompat(options: OpenAiCompatOptions): ProviderFn {
	return async function* provider(request, signal) {
		const doFetch = options.fetch ?? (globalThis.fetch as unknown as ProviderFetch);
		const headers: Record<string, string> = {
			"content-type": "application/json",
			...(options.headers ?? {}),
		};
		if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;

		const body = {
			...(request.options ?? {}),
			model: request.model,
			messages: toWireMessages(request.system, request.messages),
			tools: toWireTools(request.tools),
			stream: true,
			stream_options: { include_usage: true },
		};

		let response: ProviderResponse;
		try {
			response = await doFetch(`${options.baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
		} catch (error) {
			yield { type: "error", message: `the provider could not be reached: ${messageOf(error)}` };
			return;
		}

		if (!response.ok) {
			yield { type: "error", message: `the provider answered ${response.status}` };
			return;
		}
		if (!response.body) {
			yield { type: "error", message: "the provider sent no body" };
			return;
		}

		const tracker = new ToolCallTracker();
		let stopReason: "stop" | "length" | "toolUse" | undefined;
		let usage: Usage = emptyUsage;
		let sawTerminal = false;

		try {
			for await (const data of readSseData(response.body)) {
				if (data === "[DONE]") {
					sawTerminal = true;
					break;
				}

				let chunk: {
					choices?: readonly {
						finish_reason?: unknown;
						delta?: WireDelta;
					}[];
					usage?: WireUsage;
				};
				try {
					chunk = JSON.parse(data);
				} catch {
					yield { type: "error", message: "the provider sent a chunk that is not JSON" };
					return;
				}

				// MiHa asks for one choice, so the choice it asked for is the first one.
				const choice = chunk.choices?.[0];
				if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
					stopReason = stopReasonOf(choice.finish_reason);
					// The provider said the message is finished. Not every provider
					// sends the `[DONE]` marker — MiniMax does not — so the finish
					// reason is what makes a stream terminal.
					sawTerminal = true;
				}
				if (chunk.usage) {
					usage = mergeUsage(usage, usageOf(chunk.usage));
				}

				const delta = choice?.delta;
				if (delta !== undefined) {
					// A delta is a string. A gateway that sends `null` sends no
					// delta at all: the text "null" is not what it meant, and it
					// would be prepended to the model's answer.
					if (typeof delta.content === "string" && delta.content !== "") {
						yield { type: "text_delta", delta: delta.content };
					}
					if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
						yield { type: "reasoning_delta", delta: delta.reasoning_content };
					}
					for (const call of delta.tool_calls ?? []) {
						if (call.index === undefined) {
							// A call without a stream index cannot be correlated with the
							// others. Merging it into the first one would hand the model
							// somebody else's arguments, so it is refused.
							yield {
								type: "error",
								message: "the provider sent a tool call without a stream index",
							};
							return;
						}
						const events = tracker.feed({
							index: call.index,
							...(call.id === undefined ? {} : { id: call.id }),
							...(call.function?.name === undefined ? {} : { name: call.function.name }),
							...(call.function?.arguments === undefined
								? {}
								: { argumentsDelta: call.function.arguments }),
						});
						for (const event of events) yield event;
					}
				}
			}
		} catch (error) {
			yield { type: "error", message: `the provider stream failed: ${messageOf(error)}` };
			return;
		}

		if (!sawTerminal) {
			yield { type: "error", message: "the provider closed the stream without a terminal event" };
			return;
		}

		const unidentified = tracker.unidentified;
		if (unidentified.length > 0) {
			// The model asked for a tool and never said which one. Nothing can be
			// run for it, so it is reported rather than absorbed: a call that
			// vanishes is a call the model waits for forever, and a run that
			// claims success over it is a lie.
			yield {
				type: "error",
				message: `the provider sent a tool call that never identified itself (index ${unidentified.join(", ")})`,
			};
			return;
		}

		yield { type: "done", stopReason: stopReason ?? "stop", usage };
	};
}
