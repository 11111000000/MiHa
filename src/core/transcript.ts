/**
 * The transcript.
 *
 * An append-only list of entries. Nothing is ever rewritten; the model context is a
 * **projection** of the transcript, not a second copy of it.
 *
 * The core never writes to storage: it emits an append intent, and the host performs
 * it (ADR 0006 D31). So the transcript the core holds is its in-memory view, and the
 * durable one is what the host wrote.
 */

import type { AgentMessage } from "./messages.ts";

export interface MessageEntry {
	readonly kind: "message";
	/** The core's sequence id. Deterministic, so a run replays identically. */
	readonly id: string;
	readonly message: AgentMessage;
}

export type TranscriptEntry = MessageEntry;

export function messageEntry(id: string, message: AgentMessage): MessageEntry {
	return { kind: "message", id, message };
}

export function appendEntry(
	entries: readonly TranscriptEntry[],
	entry: TranscriptEntry,
): readonly TranscriptEntry[] {
	return [...entries, entry];
}

/**
 * The projection: the messages the model should see.
 *
 * With no compaction in the picture yet, the projection is every message in order.
 * It will become the place where the compaction marker is honoured.
 */
export function modelMessages(entries: readonly TranscriptEntry[]): readonly AgentMessage[] {
	return entries.map((entry) => entry.message);
}
