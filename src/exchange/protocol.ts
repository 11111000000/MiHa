/**
 * The exchange wire protocol.
 *
 * The frames travel in both directions and mean the same thing on both sides: the
 * frontend agent and the backend agent are peers, and neither is the master.
 *
 * **A peer may not call the other side's tools.** Delegation is a *task*, not a
 * capability transfer. Every protocol in this field draws the line the same way —
 * A2A exchanges declarations and never reaches into the other party's state or tools,
 * MCP's one server-to-client operation asks for an LLM generation and not a tool
 * call, and AG-UI carries attribution without orchestration. Our `call` frame was a
 * callable handle, and it is gone.
 *
 * Two id spaces. A **task** is one unit of delegated work and is identified by
 * `taskId`. The frames of one task belong to one task and nothing else.
 *
 * One vocabulary (ADR 0008 D45): the `event` frame carries a **journal entry** —
 * the run's own log — and not a live event. A delegated task is then a fact in a
 * log, and not a fact in a frame (ADR 0008 D49).
 */

import type { Outcome } from "../core/events.ts";
import type { JournalEntry } from "../core/journal.ts";

/** The version of the protocol. A peer that speaks another version is refused. */
export const protocolVersion = 1;

export interface OfferFrame {
	readonly kind: "offer";
	readonly version: number;
	readonly taskId: string;
	readonly task: string;
	readonly context?: string;
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
	/**
	 * The run's journal entry, as it was written.
	 *
	 * One vocabulary (ADR 0008 D45): the peer receives the same entries the run
	 * wrote, not a second kind of event that has to be translated into them.
	 */
	readonly event: JournalEntry;
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
	| ResultFrame
	| CancelFrame;

/** The transport. The same shape as the worker's channel: one channel, many listeners. */
export interface ExchangePort {
	post(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
}

const FRAME_KINDS: readonly string[] = ["offer", "accept", "refuse", "event", "result", "cancel"];

/**
 * Whether a frame is one of ours.
 *
 * A peer may send anything, including rubbish, and a peer of another version may send
 * a frame we do not know. A frame we do not recognise is ignored rather than trusted.
 */
export function isExchangeFrame(value: unknown): value is ExchangeFrame {
	if (typeof value !== "object" || value === null) return false;
	if (!("kind" in value)) return false;
	const kind = value.kind;
	return typeof kind === "string" && FRAME_KINDS.includes(kind);
}
