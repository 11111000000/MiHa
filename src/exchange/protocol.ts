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
 * This exchange is an interface between two instances of this harness, on links
 * their owner controls (ADR 0020 D107) — an in-house transport, not a standard.
 * The transport authenticates nobody: run it on trusted channels — localhost, a
 * LAN, a VPN — until an auth layer exists (ADR 0020 D108).
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
	/**
	 * What this side declared it can do — "data, not compute".
	 *
	 * A refusal says what this side will not do; the declaration says what it will.
	 * The peer may show it to its own user, so it travels with the refusal rather
	 * than being asked for again (ADR 0011 D78).
	 */
	readonly declaration?: string;
}

/**
 * A refusal, as the peer told it.
 *
 * The peer said two things: why it will not take the task, and — optionally — what it
 * declared it can do. A delegation turns the refusal into a failure, and the failure
 * carries the refusal: a failure that dropped the declaration would drop what the
 * peer knows about itself (ADR 0011 D78).
 */
export interface Refusal {
	/** Why the task was not taken. */
	readonly reason: string;
	/** What this side declared it can do. Absent when it declared nothing. */
	readonly declaration?: string;
}

/**
 * Whether a failure carries a refusal, and what the peer said.
 *
 * A failure's error is `unknown` — the outcome says a run failed, not how — so a
 * host reads a refusal through this guard rather than by guessing at the shape.
 */
export function refusalOf(error: unknown): Refusal | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if (!("reason" in error)) return undefined;
	const reason = (error as { readonly reason: unknown }).reason;
	if (typeof reason !== "string") return undefined;
	const declaration = (error as { readonly declaration?: unknown }).declaration;
	return {
		reason,
		...(typeof declaration === "string" ? { declaration } : {}),
	};
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

/**
 * A frame the transport could not carry.
 *
 * The transport **reports** and does not throw: a broken link must not take the
 * run down, and the layer above decides what a failure means (ADR 0011 D79).
 */
export interface TransportFailure {
	/** What went wrong. */
	readonly error: Error;
	/** The frame that did not go. */
	readonly frame: unknown;
}

/** The transport. The same shape as the worker's channel: one channel, many listeners. */
export interface ExchangePort {
	post(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
	/**
	 * Subscribes to the transport's failures.
	 *
	 * A transport that cannot carry a frame reports it here and does not throw: the
	 * layer above decides what the failure means, and a task that cannot be
	 * delivered ends as a failure rather than waiting for an answer that is not
	 * coming (ADR 0011 D79). A transport with nothing to report — an in-process
	 * queue — simply has no such channel.
	 *
	 * The report comes **while the frame is being sent**: the side that posted the
	 * frame learns at once that it did not go, and it does not carry on as if it
	 * had.
	 */
	onFailure?(handler: (failure: TransportFailure) => void): void;
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
