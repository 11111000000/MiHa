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

/** What the user said. */
export interface UserBody {
	readonly kind: "message";
	readonly role: "user";
	readonly content: string | readonly (TextContent | ImageContent)[];
}

/** What the assistant said, apart from the calls it asked for. */
export interface AssistantBody {
	readonly kind: "message";
	readonly role: "assistant";
	readonly content: readonly (TextContent | ImageContent | ThinkingContent)[];
	readonly usage: Usage;
	readonly stopReason: StopReason;
	readonly errorMessage?: string;
}

/** What the model asked for. */
export interface ToolCallBody {
	readonly kind: "tool_call";
	readonly callId: string;
	readonly name: string;
	readonly argumentsText: string;
}

/** What the tool answered. */
export interface ToolResultBody {
	readonly kind: "tool_result";
	readonly callId: string;
	readonly name: string;
	readonly content: readonly (TextContent | ImageContent)[];
	readonly isError: boolean;
	readonly details?: unknown;
}

/** A range of the log collapsed into a summary. */
export interface CompactionBody {
	readonly kind: "compaction";
	/** The first entry that survives; everything before it folds into the summary. */
	readonly firstKeptSeq: number;
	readonly summary: string;
	readonly dropped: number;
}

/** An earlier entry's model-facing view replaced. */
export interface ChangeBody {
	readonly kind: "change";
	/** The entry whose model-facing view is replaced. */
	readonly targetSeq: number;
	readonly content: readonly (TextContent | ImageContent)[];
}

/** A call the host refused, and why. */
export interface BlockBody {
	readonly kind: "block";
	readonly callId: string;
	readonly name: string;
	readonly reason: string;
}

/** The journal body: an entry without its envelope. */
export type JournalBody =
	| UserBody
	| AssistantBody
	| ToolCallBody
	| ToolResultBody
	| CompactionBody
	| ChangeBody
	| BlockBody;

/** A body with its envelope: the entry as the log holds it. */
export type JournalEntry = JournalBody & JournalEnvelope;

const encoder = new TextEncoder();

/** The size of a block in bytes of text. Images are not counted: they are the host's business. */
function blockBytes(block: TextContent | ImageContent | ThinkingContent | ToolCallBlock): number {
	if (block.type === "text") return encoder.encode(block.text).length;
	if (block.type === "thinking") return encoder.encode(block.thinking).length;
	if (block.type === "toolCall") return encoder.encode(`${block.name}${block.argumentsText}`).length;
	return 0;
}

/**
 * The size of a message in bytes of text.
 *
 * The context is measured in bytes, not in tokens: the core has no tokenizer and no
 * model, and a byte is the unit the result budget already speaks (ADR 0009 D50).
 */
export function messageBytes(message: AgentMessage): number {
	if (message.role === "user") {
		return typeof message.content === "string"
			? encoder.encode(message.content).length
			: message.content.reduce((sum, block) => sum + blockBytes(block), 0);
	}
	return message.content.reduce((sum, block) => sum + blockBytes(block), 0);
}

/**
 * One message in the context, and the entries it came from.
 *
 * `seqs` holds every log entry the message absorbed: the assistant message's own
 * entry and the `tool_call` entries that joined it. `calls` holds the ids of those
 * calls, so a compaction that swallows the message can swallow the answers to it —
 * a result whose question was compacted away is an orphan, and orphans are not
 * context.
 */
export interface ContextItem {
	readonly seq: number;
	readonly seqs: readonly number[];
	/** The calls this message holds, each with the sequence of the entry that asked. */
	readonly calls: readonly { readonly id: string; readonly seq: number }[];
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
	/** The calls that were asked and not yet answered, with the entry that asked. */
	readonly pending: readonly { readonly id: string; readonly seq: number }[];
	/** The calls whose questions a collapse swallowed: their answers are orphans. */
	readonly collapsedCalls: readonly { readonly id: string; readonly seq: number }[];
	/** The size of the context in bytes of text. */
	readonly bytes: number;
}

export function initialContextState(): ContextState {
	return { items: [], openAssistant: undefined, pending: [], collapsedCalls: [], bytes: 0 };
}

/**
 * One message in the context.
 *
 * `seqs` holds the entries the message absorbed — its own and the calls that joined
 * it — and `calls` their ids.
 */
function item(
	seq: number,
	message: AgentMessage,
	calls: readonly { readonly id: string; readonly seq: number }[] = [],
): ContextItem {
	return { seq, seqs: [seq], calls, message };
}

/** The folded state after one entry. */
function folded(
	items: readonly ContextItem[],
	openAssistant: number | undefined,
	pending: readonly { readonly id: string; readonly seq: number }[],
	bytes: number,
	collapsedCalls: readonly { readonly id: string; readonly seq: number }[] = [],
): ContextState {
	return { items, openAssistant, pending, bytes, collapsedCalls };
}

/** The size of a set of items. */
function itemsBytes(items: readonly ContextItem[]): number {
	return items.reduce((sum, item) => sum + messageBytes(item.message), 0);
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
): {
	readonly items: readonly ContextItem[];
	readonly pending: readonly { readonly id: string; readonly seq: number }[];
	/** The size of the answer it replaced, zero when it replaced none. */
	readonly replaced: number;
	/** True when the answer is an orphan and must not be projected. */
	readonly orphan: boolean;
} {
	const asked = state.pending.find((call) => call.id === callId);
	// The question was swallowed by a collapse: the answer is an orphan, and an
	// orphan is not context (the model must not read an answer to a question it
	// cannot see).
	if (asked === undefined && state.collapsedCalls.some((call) => call.id === callId)) {
		return { items: state.items, pending: state.pending, replaced: 0, orphan: true };
	}
	const item: ContextItem = {
		seq,
		seqs: [seq],
		calls: asked ? [asked] : [],
		message,
	};
	const waiting = asked !== undefined;
	const pending = waiting
		? state.pending.filter((call) => call !== asked)
		: state.pending;
	const index = state.items.findIndex(
		(candidate) => candidate.message.role === "toolResult" && candidate.message.toolCallId === callId,
	);
	if (waiting || index === -1) return { items: [...state.items, item], pending, replaced: 0, orphan: false };
	const items = [...state.items];
	const replaced = items[index] === undefined ? 0 : messageBytes(items[index].message);
	items[index] = item;
	return { items, pending, replaced, orphan: false };
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
				const message = { role: "user", content: entry.content } as AgentMessage;
				return folded(
					[...state.items, item(entry.seq, message)],
					undefined,
					state.pending,
					state.bytes + messageBytes(message),
				);
			}
			const message = assistantMessage(
				entry.content,
				entry.stopReason,
				entry.usage,
				entry.errorMessage,
			);
			return folded(
				[...state.items, item(entry.seq, message)],
				entry.seq,
				state.pending,
				state.bytes + messageBytes(message),
			);
		}
		case "tool_call": {
			const block = toolCall(entry.callId, entry.name, entry.argumentsText);
			const index = state.items.findIndex((item) => item.seq === state.openAssistant);
			const open = index === -1 ? undefined : state.items[index];
			if (open && open.message.role === "assistant") {
				const items = [...state.items];
				const joined = { ...open.message, content: [...open.message.content, block] };
				items[index] = {
					seq: open.seq,
					seqs: [...open.seqs, entry.seq],
					calls: [...open.calls, { id: entry.callId, seq: entry.seq }],
					message: joined,
				};
				return folded(
					items,
					state.openAssistant,
					[...state.pending, { id: entry.callId, seq: entry.seq }],
					state.bytes + messageBytes(joined) - messageBytes(open.message),
				);
			}
			// A call with no message to join starts one — the model asked, and the
			// request is what it asked.
			const message = assistantMessage([block], "toolUse");
			return folded(
				[...state.items, item(entry.seq, message, [{ id: entry.callId, seq: entry.seq }])],
				entry.seq,
				[...state.pending, { id: entry.callId, seq: entry.seq }],
				state.bytes + messageBytes(message),
			);
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
			return folded(
				recorded.items,
				undefined,
				recorded.pending,
				recorded.orphan ? state.bytes : state.bytes + messageBytes(message) - recorded.replaced,
				state.collapsedCalls,
			);
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
			return folded(
				recorded.items,
				undefined,
				recorded.pending,
				recorded.orphan ? state.bytes : state.bytes + messageBytes(message) - recorded.replaced,
				state.collapsedCalls,
			);
		}
		case "compaction": {
			// The range collapses into the summary. An item survives when it begins
			// after the boundary; the answers to the calls it took with it go too —
			// a result whose question was compacted away is an orphan, and an orphan
			// is not context.
			const collapsed = state.items.filter((item) => item.seq < entry.firstKeptSeq);
			// A collapse that swallowed nothing changes nothing: the summary would
			// only take a place the log has no room for.
			if (collapsed.length === 0) {
				return { ...state, bytes: state.bytes };
			}
			// An answer whose question was swallowed is an orphan — and it is the
			// call's own entry that says so, not its name: a name may be reused.
			const orphans = new Set(collapsed.flatMap((item) => item.calls.map((call) => call.seq)));
			const kept = state.items.filter(
				(item) =>
					item.seq >= entry.firstKeptSeq &&
					!(item.message.role === "toolResult" && orphans.has(item.calls[0]?.seq ?? -1)),
			);
			const summaryMessage = { role: "user", content: `[compacted] ${entry.summary}` } as AgentMessage;
			// The summary takes the place of the range it replaces, so the items stay
			// in the order the log has them.
			const summary = item(collapsed[0]?.seq ?? entry.seq, summaryMessage);
			const open = state.openAssistant;
			const survives = open !== undefined && kept.some((candidate) => candidate.seq === open);
			return folded(
				[summary, ...kept],
				survives ? open : undefined,
				state.pending.filter((call) => !orphans.has(call.seq)),
				itemsBytes(kept) + messageBytes(summaryMessage),
				[...state.collapsedCalls, ...collapsed.flatMap((item) => item.calls)],
			);
		}
		case "change": {
			// The model-facing view is replaced; the entry in the log is not. The
			// target may name a call that joined an assistant message — the change
			// then speaks about that message, which is where the call is seen.
			let delta = 0;
			const items = state.items.map((item) => {
				if (!item.seqs.includes(entry.targetSeq)) return item;
				const message = withContent(item.message, entry.content);
				delta += messageBytes(message) - messageBytes(item.message);
				return { ...item, message };
			});
			return folded(items, state.openAssistant, state.pending, state.bytes + delta);
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
