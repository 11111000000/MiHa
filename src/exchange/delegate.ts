/**
 * The delegating side of the exchange.
 *
 * The frontend agent hands a task to the backend agent. The peer runs the task with
 * **its own** tools and reports what happened; the delegating side never lends its
 * tools and never lends its reasoning.
 *
 * That restriction is deliberate, and it is what every agent-to-agent protocol in this
 * field does: A2A exchanges declarations and artifacts, MCP's one server-to-client
 * operation asks for an LLM generation rather than a tool call, and AG-UI carries
 * attribution without letting one agent drive another's tools. A peer that calls the
 * other side's tools acts on a decision it cannot see — it does not know which
 * affordances were exposed, how they were phrased, or what has already been tried.
 *
 * What comes back is the peer's **journal**: its entries, as it wrote them, and its
 * outcome (ADR 0008 D45, D49). One vocabulary, and the delegated task is a fact in a
 * log rather than a fact in a frame.
 */

import type { Outcome } from "../core/events.ts";
import type { JournalEntry } from "../core/journal.ts";
import { JournalEntryQueue } from "./queue.ts";
import { isExchangeFrame, protocolVersion, type ExchangeFrame, type ExchangePort } from "./protocol.ts";

export interface DelegateOptions {
	readonly port: ExchangePort;
	readonly taskId: string;
	readonly task: string;
	readonly context?: string;
}

export interface DelegatedTask {
	/** The peer's journal entries, in the order they were sent. */
	readonly events: AsyncIterable<JournalEntry>;
	/** How the task ended. */
	readonly outcome: Promise<Outcome>;
	/** Asks the peer to stop. */
	cancel(): void;
}

export function delegate(options: DelegateOptions): DelegatedTask {
	const { port, taskId, task, context } = options;

	const events = new JournalEntryQueue();
	let settle: ((outcome: Outcome) => void) | undefined;
	const outcome = new Promise<Outcome>((resolve) => {
		settle = resolve;
	});

	const finish = (result: Outcome): void => {
		settle?.(result);
		settle = undefined;
		events.close();
	};

	port.onMessage((message) => {
		if (!isExchangeFrame(message)) return;
		const frame: ExchangeFrame = message;
		if (frame.taskId !== taskId) return;

		switch (frame.kind) {
			case "offer":
			case "accept":
			case "cancel":
				return;
			case "refuse":
				finish({ kind: "failed", error: frame.reason });
				return;
			case "event":
				events.push(frame.event);
				return;
			case "result":
				finish(frame.outcome);
				return;
		}
	});

	const offer: ExchangeFrame = {
		kind: "offer",
		version: protocolVersion,
		taskId,
		task,
		...(context === undefined ? {} : { context }),
	};
	port.post(offer);

	return {
		events,
		outcome,
		cancel(): void {
			port.post({ kind: "cancel", taskId });
		},
	};
}
