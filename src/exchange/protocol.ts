/**
 * The exchange wire protocol.
 *
 * The frames travel in both directions and mean the same thing on both sides: the
 * frontend agent and the backend agent are peers, and neither is the master.
 *
 * Two id spaces. A **task** is one unit of delegated work and is identified by
 * `taskId`. A **call** is one tool invocation inside that task and is identified by
 * `callId`. Both are needed, because a task may make several calls and a peer may be
 * running several tasks at once.
 */

import type { AgentEvent, Outcome } from "../core/events.ts";
import type { ToolResult } from "../core/messages.ts";

export interface OfferFrame {
	readonly kind: "offer";
	readonly taskId: string;
	readonly task: string;
	readonly context?: string;
	/** The names of the tools the peer may call back. */
	readonly tools?: readonly string[];
}

export interface AcceptFrame {
	readonly kind: "accept";
	readonly taskId: string;
}

export interface RefuseFrame {
	readonly kind: "refuse";
	readonly taskId: string;
	readonly reason: string;
}

export interface EventFrame {
	readonly kind: "event";
	readonly taskId: string;
	readonly event: AgentEvent;
}

export interface CallFrame {
	readonly kind: "call";
	readonly taskId: string;
	readonly callId: string;
	readonly tool: string;
	readonly args: unknown;
}

export interface AnswerFrame {
	readonly kind: "answer";
	readonly taskId: string;
	readonly callId: string;
	readonly ok: boolean;
	readonly result?: ToolResult;
	readonly error?: string;
}

export interface ResultFrame {
	readonly kind: "result";
	readonly taskId: string;
	readonly outcome: Outcome;
}

export interface CancelFrame {
	readonly kind: "cancel";
	readonly taskId: string;
}

export type ExchangeFrame =
	| OfferFrame
	| AcceptFrame
	| RefuseFrame
	| EventFrame
	| CallFrame
	| AnswerFrame
	| ResultFrame
	| CancelFrame;

/** The transport. The same shape as the worker's channel: one channel, many listeners. */
export interface ExchangePort {
	post(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
}

const FRAME_KINDS: readonly string[] = [
	"offer",
	"accept",
	"refuse",
	"event",
	"call",
	"answer",
	"result",
	"cancel",
];

/**
 * Whether a frame is one of ours.
 *
 * A peer may send anything, including rubbish. A frame we do not recognise is
 * ignored rather than trusted, and a frame for another task is not ours.
 */
export function isExchangeFrame(value: unknown): value is ExchangeFrame {
	if (typeof value !== "object" || value === null) return false;
	if (!("kind" in value)) return false;
	const kind = value.kind;
	return typeof kind === "string" && FRAME_KINDS.includes(kind);
}
