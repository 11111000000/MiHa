/**
 * The event algebra.
 *
 * Two unions, and they are not interchangeable:
 *
 * - `ProviderEvent` travels **from** an adapter **to** the core. It carries deltas
 *   only. There is no whole-message snapshot on every event, which is what lets a
 *   relay strip the stream down to bare deltas and what keeps the client's
 *   reconstruction to a few lines.
 * - `AgentEvent` travels **from** the core **to** the host. It is the contract the
 *   user interface renders from, and it is the one that must stay stable.
 *
 * The core owns lifecycle events. An adapter may never emit a tool result or a
 * lifecycle event — it may only describe what the provider said.
 */

import type {
	AgentMessage,
	AssistantMessage,
	StopReason,
	ToolResult,
	ToolResultMessage,
	Usage,
} from "./messages.ts";

/** How a run ended. Four different endings, and they are not the same thing. */
export type Outcome =
	| { readonly kind: "completed" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "limitReached"; readonly turns: number };

export type MessageRole = "user" | "assistant" | "toolResult";

/**
 * The assistant message as it stands while it is still being streamed.
 *
 * It is not an `AssistantMessage`, because it has no stop reason and no final usage
 * — a provisional value would be a lie dressed as a message.
 */
export interface PartialAssistantMessage {
	readonly role: "assistant";
	readonly content: readonly import("./messages.ts").ContentBlock[];
}

export type ProviderEvent =
	| { readonly type: "text_delta"; readonly delta: string }
	| { readonly type: "reasoning_delta"; readonly delta: string }
	| { readonly type: "tool_call_start"; readonly id: string; readonly name: string }
	| { readonly type: "tool_arguments_delta"; readonly id: string; readonly delta: string }
	| { readonly type: "error"; readonly message: string }
	| { readonly type: "done"; readonly stopReason: StopReason; readonly usage: Usage };

export type AgentEvent =
	| { readonly type: "agent_start" }
	| { readonly type: "agent_end"; readonly messages: readonly AgentMessage[]; readonly outcome: Outcome }
	| { readonly type: "turn_start" }
	| { readonly type: "turn_end"; readonly message: AgentMessage; readonly toolResults: readonly ToolResultMessage[] }
	| { readonly type: "message_start"; readonly id: string; readonly role: MessageRole }
	| {
			readonly type: "message_update";
			readonly id: string;
			readonly message: PartialAssistantMessage;
			readonly providerEvent: ProviderEvent;
	  }
	| { readonly type: "message_end"; readonly id: string; readonly message: AgentMessage }
	| {
			readonly type: "tool_execution_start";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly args: Readonly<Record<string, unknown>>;
	  }
	| {
			readonly type: "tool_execution_update";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly args: Readonly<Record<string, unknown>>;
			readonly partialResult: ToolResult;
	  }
	| {
			readonly type: "tool_execution_end";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly result: ToolResult;
			readonly isError: boolean;
	  };

export type AgentEventType = AgentEvent["type"];

/** The assistant message a stream ends with, for the host's convenience. */
export type { AssistantMessage };
