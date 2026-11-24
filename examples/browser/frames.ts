/**
 * The frames the page and the worker speak to each other.
 *
 * The harness has a wire of its own — the capability bridge's frames, and the run's
 * events — and this module is the **application's** wire: what the page asks the
 * worker to do, and what the worker tells the page about it.
 *
 * Both sides import this module, so the two cannot disagree about the shape of a
 * frame: the worker builds its frames here, and the page accepts the frames this
 * module says it accepts. A frame that is not ours is refused rather than guessed
 * at — the page and the worker are the two halves of one application, and neither
 * of them has to survive a stranger.
 *
 * The run's **events** are not here: they travel in the harness's own frame,
 * `{ kind: "event", event }`, because the worker host already knows that one
 * (`src/worker/host.ts`). The journal entries travel here, because the harness
 * hands them to the host one at a time and the page is the one that keeps them.
 *
 * **The kinds here are the application's own.** The bridge owns `call` and
 * `answer` on this channel, and the worker host owns `event`: a frame that
 * carries one of those names is the harness's, and the harness answers it — or
 * swallows it. The application's frames are therefore named apart from them, and
 * the human's answer is a `decision` rather than an `answer`, because an
 * `answer` the bridge does not know is a frame that never arrives.
 */

import type { AgentEvent, JournalEntry, Outcome } from "../../src/core/index.ts";
import type { ToolSchema } from "../../src/index.ts";

/**
 * A tool the page offers to the agent.
 *
 * The page owns its tools: it says what they are called, what they are for, and
 * what arguments they take — in the harness's own dialect, so the worker does not
 * have to translate. The worker turns each of these into a tool that calls the
 * page's capability of the same name through the bridge.
 */
export interface OfferedTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: ToolSchema;
}

/** What the worker asks the human about. */
export interface ApprovalRequest {
	/** The question's id: the answer carries it back. */
	readonly id: string;
	/** The tool the agent wants to run. */
	readonly tool: string;
	/** The arguments the core validated, before any rewrite. */
	readonly args: Readonly<Record<string, unknown>>;
}

/** The human's answer. */
export interface HumanDecision {
	readonly allow: boolean;
	/** Why the call was refused. The model reads it. */
	readonly reason?: string;
}

/** The page asks for a run. */
export interface RunFrame {
	readonly kind: "run";
	readonly text: string;
	/**
	 * The provider's key.
	 *
	 * It is asked for in the page, kept in memory, and handed over with the run. It
	 * is never written to a file, never bundled, and never sent anywhere but the
	 * provider.
	 */
	readonly apiKey: string;
	/** The tools the page offers. The worker offers the agent nothing else. */
	readonly catalogue: readonly OfferedTool[];
}

/** The human's answer to a question the worker asked. */
export interface DecisionFrame {
	readonly kind: "decision";
	readonly id: string;
	readonly allow: boolean;
	readonly reason?: string;
}

/** The page offers a task to the peer. */
export interface PeerOfferFrame {
	readonly kind: "peer_offer";
	readonly taskId: string;
	readonly task: string;
	/** The provider's key, for the peer that runs the task. */
	readonly apiKey: string;
	readonly context?: string;
}

/** The page stops the run. */
export interface CancelFrame {
	readonly kind: "cancel";
}

/** The worker asks the human whether a call may run. */
export interface ApproveFrame {
	readonly kind: "approve";
	readonly id: string;
	readonly tool: string;
	readonly args: Readonly<Record<string, unknown>>;
}

/** One entry of the run's journal, as it was written. */
export interface JournalFrame {
	readonly kind: "journal";
	readonly entry: JournalEntry;
}

/** One entry of the peer's journal, as the peer wrote it. */
export interface PeerJournalFrame {
	readonly kind: "peer_journal";
	readonly entry: JournalEntry;
}

/** How the peer's task ended. */
export interface PeerOutcomeFrame {
	readonly kind: "peer_outcome";
	readonly taskId: string;
	readonly outcome: Outcome;
}

/** Something the worker wants to say that is not an event. */
export interface NoteFrame {
	readonly kind: "note";
	readonly text: string;
}

/** The frames the page sends. */
export type PageToWorkerFrame = RunFrame | DecisionFrame | PeerOfferFrame | CancelFrame;

/** The frames the worker sends. */
export type WorkerToPageFrame =
	| ApproveFrame
	| JournalFrame
	| PeerJournalFrame
	| PeerOutcomeFrame
	| NoteFrame;

/** The kinds the page sends, in the order the module declares them. */
export const PAGE_TO_WORKER_KINDS: readonly string[] = ["run", "decision", "peer_offer", "cancel"];

/** The kinds the worker sends, in the order the module declares them. */
export const WORKER_TO_PAGE_KINDS: readonly string[] = [
	"approve",
	"journal",
	"peer_journal",
	"peer_outcome",
	"note",
];

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a frame of the given kind. */
function isKind(value: unknown, kind: string): value is Record<string, unknown> {
	return isRecord(value) && value.kind === kind;
}

/** Whether a value is a non-empty string. */
function isText(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

/** The page's request for a run. */
export function runFrame(
	text: string,
	apiKey: string,
	catalogue: readonly OfferedTool[],
): RunFrame {
	return { kind: "run", text, apiKey, catalogue };
}

/** The human's answer. */
export function decisionFrame(id: string, allow: boolean, reason?: string): DecisionFrame {
	return { kind: "decision", id, allow, ...(reason === undefined ? {} : { reason }) };
}

/** The page's offer of a task to the peer. */
export function peerOfferFrame(
	taskId: string,
	task: string,
	apiKey: string,
	context?: string,
): PeerOfferFrame {
	return {
		kind: "peer_offer",
		taskId,
		task,
		apiKey,
		...(context === undefined ? {} : { context }),
	};
}

/** The page's stop. */
export function cancelFrame(): CancelFrame {
	return { kind: "cancel" };
}

/** The worker's question to the human. */
export function approveFrame(
	id: string,
	tool: string,
	args: Readonly<Record<string, unknown>>,
): ApproveFrame {
	return { kind: "approve", id, tool, args };
}

/** One entry of the run's journal. */
export function journalFrame(entry: JournalEntry): JournalFrame {
	return { kind: "journal", entry };
}

/** One entry of the peer's journal. */
export function peerJournalFrame(entry: JournalEntry): PeerJournalFrame {
	return { kind: "peer_journal", entry };
}

/** How the peer's task ended. */
export function peerOutcomeFrame(taskId: string, outcome: Outcome): PeerOutcomeFrame {
	return { kind: "peer_outcome", taskId, outcome };
}

/** Something the worker wants to say. */
export function noteFrame(text: string): NoteFrame {
	return { kind: "note", text };
}

/** Whether the frame asks for a run. */
export function isRunFrame(value: unknown): value is RunFrame {
	return (
		isKind(value, "run") &&
		isText(value.text) &&
		typeof value.apiKey === "string" &&
		Array.isArray(value.catalogue)
	);
}

/** Whether the frame answers a question. */
export function isDecisionFrame(value: unknown): value is DecisionFrame {
	return (
		isKind(value, "decision") &&
		isText(value.id) &&
		typeof value.allow === "boolean" &&
		(value.reason === undefined || typeof value.reason === "string")
	);
}

/** Whether the frame offers a task to the peer. */
export function isPeerOfferFrame(value: unknown): value is PeerOfferFrame {
	return (
		isKind(value, "peer_offer") &&
		isText(value.taskId) &&
		isText(value.task) &&
		typeof value.apiKey === "string" &&
		(value.context === undefined || typeof value.context === "string")
	);
}

/** Whether the frame stops the run. */
export function isCancelFrame(value: unknown): value is CancelFrame {
	return isKind(value, "cancel");
}

/** Whether the frame asks the human a question. */
export function isApproveFrame(value: unknown): value is ApproveFrame {
	return isKind(value, "approve") && isText(value.id) && isText(value.tool);
}

/** Whether the frame carries an entry of the run's journal. */
export function isJournalFrame(value: unknown): value is JournalFrame {
	return isKind(value, "journal") && isRecord(value.entry);
}

/** Whether the frame carries an entry of the peer's journal. */
export function isPeerJournalFrame(value: unknown): value is PeerJournalFrame {
	return isKind(value, "peer_journal") && isRecord(value.entry);
}

/** Whether the frame says how the peer's task ended. */
export function isPeerOutcomeFrame(value: unknown): value is PeerOutcomeFrame {
	return isKind(value, "peer_outcome") && isText(value.taskId) && isRecord(value.outcome);
}

/** Whether the frame carries a note. */
export function isNoteFrame(value: unknown): value is NoteFrame {
	return isKind(value, "note") && typeof value.text === "string";
}

/** The event of a run, as the harness frames it. */
export function eventFrame(event: AgentEvent): { readonly kind: "event"; readonly event: AgentEvent } {
	return { kind: "event", event };
}
