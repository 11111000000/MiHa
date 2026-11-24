/**
 * The page: the application's half.
 *
 * The page owns everything the application owns:
 *
 * - the **tools** — what the agent may call, and what each of them does;
 * - the **directory** those tools work on;
 * - the **key** of the provider, which is asked for here and kept in memory;
 * - the **human** — the page asks, and the answer goes back to the worker.
 *
 * Nothing here runs the harness. The page asks the worker for a run, receives the
 * run's events and its journal entries as they are written, and shows them.
 *
 * The page is written without a DOM, so that its own half of the application can
 * be driven by a machine: `page.entry.ts` is the thin layer that binds this to
 * the document.
 */

import type { AgentEvent, JournalEntry, Outcome } from "../../src/core/index.ts";
import type { CapabilityFn } from "../../src/worker/protocol.ts";
import {
	decisionFrame,
	isApproveFrame,
	isJournalFrame,
	isNoteFrame,
	isPeerJournalFrame,
	isPeerOutcomeFrame,
	peerOfferFrame,
	runFrame,
	type ApprovalRequest,
	type HumanDecision,
	type OfferedTool,
} from "./frames.ts";

export interface PageOptions {
	/** The tools the page offers. */
	readonly catalogue: readonly OfferedTool[];
	/**
	 * The capabilities the bridge may reach.
	 *
	 * The table is the page's, and the page checks it against the catalogue: a tool
	 * the page cannot perform is not offered, so the agent cannot call it.
	 */
	readonly capabilities: Readonly<Record<string, CapabilityFn>>;
	/**
	 * Asks the human.
	 *
	 * The page's own dialog answers this; the machine's test harness answers it
	 * with a script. Either way the question is asked and answered — a refusal the
	 * human cannot answer is a run that waits forever.
	 */
	readonly askHuman: (request: ApprovalRequest) => Promise<HumanDecision>;
	/** Sends a frame to the worker. */
	readonly post: (frame: unknown) => void;
	readonly onEvent?: (event: AgentEvent) => void;
	readonly onJournal?: (entry: JournalEntry) => void;
	readonly onPeerJournal?: (entry: JournalEntry) => void;
	readonly onPeerOutcome?: (taskId: string, outcome: Outcome) => void;
	readonly onNote?: (text: string) => void;
}

export interface PageApp {
	/** Takes a frame the worker sent. Says whether it was one of ours. */
	handle(frame: unknown): boolean;
	/** Asks the worker for a run. Says whether it was asked for. */
	run(text: string, apiKey: string): boolean;
	/** Asks the worker to offer a task to the peer. */
	offerToPeer(taskId: string, task: string, apiKey: string, context?: string): boolean;
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The page's half of the application.
 */
export function createPageApp(options: PageOptions): PageApp {
	/**
	 * Asks the human and answers the worker.
	 *
	 * A question that could not be asked is answered with a refusal: the run
	 * continues, and the model reads why the call did not happen.
	 */
	const ask = async (frame: { readonly id: string; readonly tool: string; readonly args: Readonly<Record<string, unknown>> }): Promise<void> => {
		let decision: HumanDecision;
		try {
			decision = await options.askHuman({
				id: frame.id,
				tool: frame.tool,
				args: frame.args,
			});
		} catch (error) {
			decision = { allow: false, reason: `the question could not be asked: ${messageOf(error)}` };
		}
		options.post(decisionFrame(frame.id, decision.allow, decision.reason));
	};

	/** Takes a frame the worker sent. */
	const handle = (frame: unknown): boolean => {
		if (isApproveFrame(frame)) {
			void ask(frame);
			return true;
		}
		if (isJournalFrame(frame)) {
			options.onJournal?.(frame.entry);
			return true;
		}
		if (isPeerJournalFrame(frame)) {
			options.onPeerJournal?.(frame.entry);
			return true;
		}
		if (isPeerOutcomeFrame(frame)) {
			options.onPeerOutcome?.(frame.taskId, frame.outcome);
			return true;
		}
		if (isNoteFrame(frame)) {
			options.onNote?.(frame.text);
			return true;
		}
		return false;
	};

	/**
	 * Asks the worker for a run.
	 *
	 * The catalogue is checked first: a tool the page cannot perform is not
	 * offered, and a run is not started with a promise the page cannot keep.
	 */
	const run = (text: string, apiKey: string): boolean => {
		const missing = options.catalogue.filter(
			(tool) => !Object.prototype.hasOwnProperty.call(options.capabilities, tool.name),
		);
		if (missing.length > 0) {
			options.onNote?.(
				`the page offers a tool it cannot perform (${missing.map((tool) => tool.name).join(", ")}), so the run was not started`,
			);
			return false;
		}
		options.post(runFrame(text, apiKey, options.catalogue));
		return true;
	};

	/** Asks the worker to offer a task to the peer. */
	const offerToPeer = (taskId: string, task: string, apiKey: string, context?: string): boolean => {
		options.post(peerOfferFrame(taskId, task, apiKey, context));
		return true;
	};

	return { handle, run, offerToPeer };
}
