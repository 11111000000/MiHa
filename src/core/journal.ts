/**
 * The journal.
 *
 * One append-only log of durable events (ADR 0006 D39, ADR 0008 D45). The journal
 * entry **is** the durable event: there is no second vocabulary for what happened.
 * The live stream carries only what cannot be recomputed — the deltas of a message
 * being written — and those are ephemeral.
 *
 * The model's context is a **projection** of the journal, folded forward one entry
 * at a time. The fold is the only reader of the log, which is what makes the replay
 * law statable: *fold(replay(log)) ≡ fold(log)* — the same log, replayed, gives the
 * same context.
 *
 * Six kinds, and each earns its place:
 *
 * - `message` — what the user or the assistant said
 * - `tool_call` — what the model asked for
 * - `tool_result` — what the tool answered
 * - `compaction` — a range of the log collapsed into a summary
 * - `change` — an earlier entry's model-facing view replaced; the history untouched
 * - `block` — a call the host refused, and why
 */

import {
	assistantMessage,
	toolCall,
	toolResultMessage,
	type AgentMessage,
	type ImageContent,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type ToolCallBlock,
	type Usage,
} from "./messages.ts";

/** The format of the log. The host stores it; a future format bumps it. */
export const JOURNAL_VERSION = 1;

/**
 * How many entries the core keeps resident. The host holds the whole log; the core
 * keeps a window, because the resident memory of a run must not grow with its length
 * (law R1, ADR 0009 D52).
 */
export const DEFAULT_JOURNAL_WINDOW = 64;

/**
 * Resolves the host's window into the one the core keeps.
 *
 * Zero is honoured: the core keeps no journal at all, and the host's copy is the
 * only one. A window that is not a number, or a negative one, is nonsense, and
 * nonsense gets the default.
 */
export function resolveJournalWindow(window: number | undefined): number {
	if (window === undefined) return DEFAULT_JOURNAL_WINDOW;
	if (Number.isNaN(window) || window < 0) return DEFAULT_JOURNAL_WINDOW;
	return window;
}

/** Every entry carries the same envelope: where it is in the log, and in what format. */
export interface JournalEnvelope {
	/** The core's sequence number. Monotonic and deterministic, so a run replays. */
	readonly seq: number;
	/** The format the entry was written in. */
	readonly version: number;
}

export type JournalEntry =
	| (JournalEnvelope & {
			readonly kind: "message";
			readonly role: "user";
			readonly content: string | readonly (TextContent | ImageContent)[];
	  })
	| (JournalEnvelope & {
			readonly kind: "message";
			readonly role: "assistant";
			readonly content: readonly (TextContent | ImageContent | ThinkingContent)[];
			readonly usage: Usage;
			readonly stopReason: StopReason;
			readonly errorMessage?: string;
	  })
	| (JournalEnvelope & {
			readonly kind: "tool_call";
			readonly callId: string;
			readonly name: string;
			readonly argumentsText: string;
	  })
	| (JournalEnvelope & {
			readonly kind: "tool_result";
			readonly callId: string;
			readonly name: string;
			readonly content: readonly (TextContent | ImageContent)[];
			readonly isError: boolean;
			readonly details?: unknown;
	  })
	| (JournalEnvelope & {
			readonly kind: "compaction";
			/** The first entry that survives; everything before it folds into the summary. */
			readonly firstKeptSeq: number;
			readonly summary: string;
			readonly dropped: number;
	  })
	| (JournalEnvelope & {
			readonly kind: "change";
			/** The entry whose model-facing view is replaced. */
			readonly targetSeq: number;
			readonly content: readonly (TextContent | ImageContent)[];
	  })
	| (JournalEnvelope & {
			readonly kind: "block";
			readonly callId: string;
			readonly name: string;
			readonly reason: string;
	  });

/** The journal body: an entry without its envelope. */
export type JournalBody =
	| Omit<Extract<JournalEntry, { kind: "message"; role: "user" }>, keyof JournalEnvelope>
	| Omit<Extract<JournalEntry, { kind: "message"; role: "assistant" }>, keyof JournalEnvelope>
	| Omit<Extract<JournalEntry, { kind: "tool_call" }>, keyof JournalEnvelope>
	| Omit<Extract<JournalEntry, { kind: "tool_result" }>, keyof JournalEnvelope>
	| Omit<Extract<JournalEntry, { kind: "compaction" }>, keyof JournalEnvelope>
	| Omit<Extract<JournalEntry, { kind: "change" }>, keyof JournalEnvelope>
	| Omit<Extract<JournalEntry, { kind: "block" }>, keyof JournalEnvelope>;

/**
 * One message in the context, and the entries it came from.
 *
 * `seqs` holds every log entry the message absorbed: the assistant message's own
 * entry and the `tool_call` entries that joined it. `calls` holds the ids of those
 * calls, so a compaction that swallows the message can swallow the answers to it —
 * a result whose question was compacted away is an orphan, and orphans are not
 * context.
 */
interface ContextItem {
	readonly seq: number;
	readonly seqs: readonly number[];
	readonly calls: readonly string[];
	readonly message: AgentMessage;
}

/**
 * The folded context.
 *
 * `items` is the model's world; `openAssistant` is the **sequence number** of the
 * assistant message that may still take tool calls — the calls of a turn follow its
 * message, and the first result closes it.
 */
export interface ContextState {
	readonly items: readonly ContextItem[];
	readonly openAssistant: number | undefined;
	/** The calls that were asked and not yet answered. */
	readonly pending: readonly string[];
}

export function initialContextState(): ContextState {
	return { items: [], openAssistant: undefined, pending: [] };
}

/**
 * Replaces the model-facing view of a message.
 *
 * A change **replaces**: what the model sees of that entry becomes the new content.
 * The tool calls of an assistant message are part of the pairing with the results, so
 * they survive the replacement — the text is what changes.
 */
function withContent(message: AgentMessage, content: readonly (TextContent | ImageContent)[]): AgentMessage {
	if (message.role === "assistant") {
		const calls = message.content.filter(
			(block): block is ToolCallBlock => block.type === "toolCall",
		);
		return { ...message, content: [...content, ...calls] };
	}
	if (message.role === "toolResult") return { ...message, content };
	return { role: "user", content };
}

/**
 * Records an answer for a call.
 *
 * An answer belongs to the call that asked for it, and a call has exactly one
 * answer (law M1). The fold knows which calls are still waiting: an answer for a
 * waiting call is its answer, and it closes the call. An answer for a call that is
 * not waiting is a second answer for a call already answered — the later entry
 * replaces the earlier, and the model reads one answer per call.
 *
 * A call id may be reused in a later turn: that is a different call, and the fold
 * knows it because the log carries a new `tool_call` entry for it.
 */
function answer(
	state: ContextState,
	seq: number,
	callId: string,
	message: AgentMessage,
): { readonly items: readonly ContextItem[]; readonly pending: readonly string[] } {
	const item: ContextItem = { seq, seqs: [seq], calls: [], message };
	const waiting = state.pending.includes(callId);
	const pending = waiting ? state.pending.filter((id) => id !== callId) : state.pending;
	const index = state.items.findIndex(
		(candidate) => candidate.message.role === "toolResult" && candidate.message.toolCallId === callId,
	);
	if (waiting || index === -1) return { items: [...state.items, item], pending };
	const items = [...state.items];
	items[index] = item;
	return { items, pending };
}

/**
 * Folds one entry into the context.
 *
 * The fold is the only reader of the journal. It is pure, so folding the log forward
 * entry by entry and projecting the whole log are the same thing — the replay law.
 */
export function foldContext(state: ContextState, entry: JournalEntry): ContextState {
	switch (entry.kind) {
		case "message": {
			if (entry.role === "user") {
				return {
					items: [
						...state.items,
						{ seq: entry.seq, seqs: [entry.seq], calls: [], message: { role: "user", content: entry.content } },
					],
					openAssistant: undefined,
					pending: state.pending,
				};
			}
			const message = assistantMessage(
				entry.content,
				entry.stopReason,
				entry.usage,
				entry.errorMessage,
			);
			return {
				items: [...state.items, { seq: entry.seq, seqs: [entry.seq], calls: [], message }],
				openAssistant: entry.seq,
				pending: state.pending,
			};
		}
		case "tool_call": {
			const block = toolCall(entry.callId, entry.name, entry.argumentsText);
			const index = state.items.findIndex((item) => item.seq === state.openAssistant);
			const open = index === -1 ? undefined : state.items[index];
			if (open && open.message.role === "assistant") {
				const items = [...state.items];
				items[index] = {
					seq: open.seq,
					seqs: [...open.seqs, entry.seq],
					calls: [...open.calls, entry.callId],
					message: { ...open.message, content: [...open.message.content, block] },
				};
				return {
					items,
					openAssistant: state.openAssistant,
					pending: [...state.pending, entry.callId],
				};
			}
			// A call with no message to join starts one — the model asked, and the
			// request is what it asked.
			const message = assistantMessage([block], "toolUse");
			return {
				items: [
					...state.items,
					{ seq: entry.seq, seqs: [entry.seq], calls: [entry.callId], message },
				],
				openAssistant: entry.seq,
				pending: [...state.pending, entry.callId],
			};
		}
		case "tool_result": {
			const message = toolResultMessage(
				entry.callId,
				entry.name,
				entry.content,
				entry.isError,
				entry.details,
			);
			const recorded = answer(state, entry.seq, entry.callId, message);
			return {
				items: recorded.items,
				openAssistant: undefined,
				pending: recorded.pending,
			};
		}
		case "block": {
			// The refusal is the model's answer: it reads why, and it recovers.
			const message = toolResultMessage(
				entry.callId,
				entry.name,
				[{ type: "text", text: entry.reason }],
				true,
			);
			const recorded = answer(state, entry.seq, entry.callId, message);
			return {
				items: recorded.items,
				openAssistant: undefined,
				pending: recorded.pending,
			};
		}
		case "compaction": {
			// The range collapses into the summary. An item survives when it begins
			// after the boundary; the answers to the calls it took with it go too —
			// a result whose question was compacted away is an orphan, and an orphan
			// is not context.
			const collapsed = state.items.filter((item) => item.seq < entry.firstKeptSeq);
			const orphans = new Set(collapsed.flatMap((item) => item.calls));
			const kept = state.items.filter(
				(item) =>
					item.seq >= entry.firstKeptSeq &&
					!(item.message.role === "toolResult" && orphans.has(item.message.toolCallId)),
			);
			const summary: ContextItem = {
				seq: entry.seq,
				seqs: [entry.seq],
				calls: [],
				message: { role: "user", content: `[compacted] ${entry.summary}` },
			};
			const open = state.openAssistant;
			const survives = open !== undefined && kept.some((item) => item.seq === open);
			return {
				items: [summary, ...kept],
				openAssistant: survives ? open : undefined,
				pending: state.pending,
			};
		}
		case "change": {
			// The model-facing view is replaced; the entry in the log is not. The
			// target may name a call that joined an assistant message — the change
			// then speaks about that message, which is where the call is seen.
			const items = state.items.map((item) =>
				item.seqs.includes(entry.targetSeq)
					? { ...item, message: withContent(item.message, entry.content) }
					: item,
			);
			return { items, openAssistant: state.openAssistant, pending: state.pending };
		}
	}
}

/** The messages the model sees. */
export function contextMessages(state: ContextState): readonly AgentMessage[] {
	return state.items.map((item) => item.message);
}

/** The context of a whole log: the same fold, run over every entry. */
export function projectContext(entries: readonly JournalEntry[]): readonly AgentMessage[] {
	return contextMessages(entries.reduce(foldContext, initialContextState()));
}
