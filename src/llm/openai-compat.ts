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
	readonly role: "user" | "assistant" | "tool";
	readonly content: string | null;
	readonly tool_call_id?: string;
	readonly tool_calls?: readonly WireToolCall[];
}

function textOf(content: readonly ContentBlock[]): string {
	let text = "";
	for (const block of content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

/** Lowers the core's messages to the wire format. */
export function toWireMessages(messages: readonly AgentMessage[]): readonly WireMessage[] {
	const wire: WireMessage[] = [];
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

/**
 * Creates an OpenAI-compatible provider.
 *
 * The options bag of the request is passed through to the wire verbatim, so a host
 * can reach a provider knob MiHa has never heard of.
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
			model: request.model,
			messages: toWireMessages(request.messages),
			tools: toWireTools(request.tools),
			stream: true,
			stream_options: { include_usage: true },
			...(request.options ?? {}),
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
						delta?: {
							content?: string;
							reasoning_content?: string;
							tool_calls?: readonly {
								index?: number;
								id?: string;
								function?: { name?: string; arguments?: string };
							}[];
						};
					}[];
					usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
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
				}
				if (chunk.usage) {
					usage = {
						input: chunk.usage.input ?? 0,
						output: chunk.usage.output ?? 0,
						cacheRead: chunk.usage.cacheRead ?? 0,
						cacheWrite: chunk.usage.cacheWrite ?? 0,
						reasoning: 0,
					};
				}

				const delta = choice?.delta;
				if (delta?.content !== undefined && delta.content !== "") {
					yield { type: "text_delta", delta: delta.content };
				}
				if (delta?.reasoning_content !== undefined && delta.reasoning_content !== "") {
					yield { type: "reasoning_delta", delta: delta.reasoning_content };
				}
				for (const call of delta?.tool_calls ?? []) {
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
		} catch (error) {
			yield { type: "error", message: `the provider stream failed: ${messageOf(error)}` };
			return;
		}

		if (!sawTerminal) {
			yield { type: "error", message: "the provider closed the stream without a terminal event" };
			return;
		}

		yield { type: "done", stopReason: stopReason ?? "stop", usage };
	};
}
