/**
 * The message algebra.
 *
 * Every type here is a discriminated union or a readonly record. Nothing in this
 * module is mutated after it is published, and nothing is partially defined: a value
 * either has every field the type promises, or it does not exist.
 *
 * The vocabulary is deliberately provider-neutral. There is no `api`, no `provider`
 * and no cost table on a message, because the core must not know which vendor served
 * it — that is the adapter layer's business, and it is what lets the same message
 * travel over the peer link unchanged.
 *
 * **There is no timestamp.** The core does not read a clock (ADR 0006 D29), so it
 * cannot stamp anything. Order is positional — the transcript is append-only, and
 * position is the order. When the host needs times, it stamps them as it records.
 */

export type TextContent = { readonly type: "text"; readonly text: string };

export type ImageContent = { readonly type: "image"; readonly data: string; readonly mimeType: string };

export type ThinkingContent = { readonly type: "thinking"; readonly thinking: string };

/**
 * A tool call.
 *
 * `argumentsText` is the **raw text** the provider sent, kept verbatim. The parsed
 * arguments are derived from it and never replace it, so the transcript stays
 * lossless and an incomplete argument string is detectable (law M2).
 */
export type ToolCallBlock = {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly argumentsText: string;
};

export type ContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallBlock;

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning: number;
}

export interface UserMessage {
	readonly role: "user";
	readonly content: string | readonly (TextContent | ImageContent)[];
}

export interface AssistantMessage {
	readonly role: "assistant";
	readonly content: readonly ContentBlock[];
	readonly usage: Usage;
	readonly stopReason: StopReason;
	readonly errorMessage?: string;
}

export interface ToolResultMessage {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: readonly (TextContent | ImageContent)[];
	readonly isError: boolean;
	readonly details?: unknown;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** A message as the agent core sees it. A host may widen this by declaration merging. */
export type AgentMessage = Message;

/** What a tool returns. `isError` is a value, not an exception (law M3). */
export interface ToolResult {
	readonly content: readonly (TextContent | ImageContent)[];
	readonly details?: unknown;
	readonly isError?: boolean;
}

export const emptyUsage: Usage = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0,
});

export function text(text: string): TextContent {
	return { type: "text", text };
}

export function image(data: string, mimeType: string): ImageContent {
	return { type: "image", data, mimeType };
}

export function thinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

export function toolCall(id: string, name: string, argumentsText: string): ToolCallBlock {
	return { type: "toolCall", id, name, argumentsText };
}

export function userMessage(content: string): UserMessage {
	return { role: "user", content };
}

export function assistantMessage(
	content: readonly ContentBlock[],
	stopReason: StopReason,
	usage: Usage = emptyUsage,
	errorMessage?: string,
): AssistantMessage {
	return errorMessage === undefined
		? { role: "assistant", content, usage, stopReason }
		: { role: "assistant", content, usage, stopReason, errorMessage };
}

export function toolResultMessage(
	toolCallId: string,
	toolName: string,
	content: readonly (TextContent | ImageContent)[],
	isError: boolean,
	details?: unknown,
): ToolResultMessage {
	return details === undefined
		? { role: "toolResult", toolCallId, toolName, content, isError }
		: { role: "toolResult", toolCallId, toolName, content, isError, details };
}
