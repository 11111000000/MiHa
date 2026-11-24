/**
 * The receiving side of the exchange.
 *
 * The peer offers a task; this side decides whether to take it, runs it with **its
 * own** tools, and reports what happened: the run's journal entries go back as they
 * are written, and the run's own outcome ends the task.
 *
 * It is `delegate()` read from the other end (ADR 0008 D49), and the symmetry is the
 * point: the delegating side offers a task and forwards what comes back; the
 * receiving side takes a task and sends what happened. Neither side lends the other
 * a handle on its tools — a peer gets a task, never a capability (ADR 0007 D41).
 *
 * **The task ends when our own work is done, not when the machine says so.** The
 * core ends a run when the machine is finished, and the machine can be finished
 * while one of our own tools is still winding down after an abort. So the receiving
 * side counts the calls that are still running — the tools the journal says are
 * waiting for an answer, and the provider call in flight — and only then tells the
 * peer that the task is over (ADR 0011 D62).
 *
 * **A task that cannot be answered must not stay open.** A transport that throws
 * and a journal hook that throws both end the task as a failure that says so: a peer
 * that waits for an answer that is not coming is a peer that waits forever
 * (ADR 0011 D79, D81).
 */

import { runAgent } from "../core/loop.ts";
import type { HarnessHost } from "../core/loop.ts";
import type { HarnessConfig } from "../core/run.ts";
import type { Outcome, ProviderEvent } from "../core/events.ts";
import { userMessage } from "../core/messages.ts";
import type { JournalEntry } from "../core/journal.ts";
import { JournalEntryQueue } from "./queue.ts";
import { toolRegistry } from "../core/tools.ts";
import {
	isExchangeFrame,
	protocolVersion,
	type ExchangeFrame,
	type ExchangePort,
	type OfferFrame,
	type Refusal,
} from "./protocol.ts";

/**
 * The host's answer to an offer: take the task, or refuse it and say why.
 *
 * A refusal without a reason is not a refusal the peer can act on: it is a shrug.
 * A refusal may also carry a **declaration** of what this side can do — "data, not
 * compute" — which the peer can show to its own user (ADR 0011 D78).
 */
export type TaskDecision =
	| { readonly kind: "accept" }
	| { readonly kind: "refuse"; readonly reason: string; readonly declaration?: string };

export interface ReceiveOptions {
	readonly port: ExchangePort;
	/** The task we are receiving. A frame for another task is not ours. */
	readonly taskId: string;
	/** Our own model and our own tools — never the peer's. */
	readonly config: HarnessConfig;
	/** Our own host: the provider, the policy, the capabilities our tools may use. */
	readonly host: HarnessHost;
	/**
	 * The host's answer to "shall we take this task?".
	 *
	 * Absent, every task is taken. A refusal carries the reason the peer is told, and
	 * may carry a declaration of what this side can do.
	 */
	readonly decide?: (offer: OfferFrame) => TaskDecision;
}

export interface ReceivedTask {
	/** The run's journal entries, in the order they were written. */
	readonly events: AsyncIterable<JournalEntry>;
	/** How the task ended. */
	readonly outcome: Promise<Outcome>;
	/**
	 * Stops the run.
	 *
	 * The peer is not told with a frame: there is nobody above us to tell. It
	 * learns from the result, which says the run was cancelled.
	 */
	cancel(): void;
}

/**
 * The prompt the run starts with: the task, and the context the peer sent.
 *
 * The context is the peer's own words about the world, so it is marked as the peer's:
 * the model can tell where the peer's description ends and the task begins.
 */
function promptOf(offer: OfferFrame): string {
	if (offer.context === undefined) return offer.task;
	return `${offer.task}\n\nThe peer says:\n${offer.context}`;
}

/**
 * The failure's own message, and nothing else.
 *
 * `error.message` for an error — not `String(error)`, which would dress it up as
 * `"Error: the disk is on fire"` and be something other than what failed.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A reason the peer can act on.
 *
 * A refusal without a reason is a shrug, and a shrug is not a refusal: the reason
 * becomes a stated one.
 */
function stated(reason: string): string {
	if (typeof reason !== "string" || reason.trim() === "") {
		return "the host refused the task without saying why";
	}
	return reason;
}

/**
 * Receives a task from a peer, and runs it.
 *
 * The side is quiet until the peer offers: the handle is returned at once, and its
 * `events` and `outcome` say what happened once there is something to say.
 */
export function receive(options: ReceiveOptions): ReceivedTask {
	const { port, taskId, config, host, decide } = options;

	const events = new JournalEntryQueue();
	const controller = new AbortController();
	let settle: ((outcome: Outcome) => void) | undefined;
	const outcome = new Promise<Outcome>((resolve) => {
		settle = resolve;
	});

	/** Whether the task is over: the peer was told, and the outcome settled. */
	let over = false;

	/** Settles the outcome and closes the entries. */
	const settleOutcome = (result: Outcome): void => {
		settle?.(result);
		settle = undefined;
		events.close();
	};

	/** Ends the task: the peer gets the outcome, and the entries stop. */
	const finish = (result: Outcome): void => {
		if (over) return;
		over = true;
		settleOutcome(result);
	};

	/**
	 * Posts a frame to the peer, and hands back the failure when there is one.
	 *
	 * The transport's failure is not hidden here: the caller decides what a frame
	 * that did not go means.
	 */
	const post = (frame: ExchangeFrame): Error | undefined => {
		try {
			port.post(frame);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	};

	/**
	 * Ends the task as a failure, and tells the peer why.
	 *
	 * The peer is owed an answer. A task that ends without one leaves the peer
	 * waiting, and a peer that waits learns nothing.
	 */
	const fail = (error: string): void => {
		if (over) return;
		over = true;
		// The frame goes out even though the task is over: this is the last thing
		// the peer hears, and it is the answer.
		post({ kind: "result", taskId, outcome: { kind: "failed", error } });
		settleOutcome({ kind: "failed", error });
	};

	/**
	 * Sends a frame to the peer.
	 *
	 * A transport that throws ends the task: the peer cannot hear us, so it would
	 * wait for an answer that is not coming (ADR 0011 D79). The failure carries the
	 * reason, the outcome settles, and the run's own journal keeps the entries it
	 * wrote — the run is not the transport's business.
	 */
	const send = (frame: ExchangeFrame): boolean => {
		if (over) return false;
		const failure = post(frame);
		if (failure === undefined) return true;
		fail(`the peer could not be reached: ${failure.message}`);
		return false;
	};

	/** Ends the task, and tells the peer how it ended. */
	const end = (result: Outcome): void => {
		if (over) return;
		over = true;
		const failure = post({ kind: "result", taskId, outcome: result });
		if (failure !== undefined) {
			// The answer did not go, so the task did not do what it was for.
			settleOutcome({ kind: "failed", error: `the peer could not be reached: ${failure.message}` });
			return;
		}
		settleOutcome(result);
	};

	/**
	 * The calls of ours that are still running.
	 *
	 * The count is over **promises**, not over journal entries: the journal says a
	 * call was *answered*, and on a cancellation the synthetic answer is written
	 * before the tool has noticed the abort — so the journal cannot tell "answered"
	 * from "stopped". Only the promise can.
	 *
	 * The cost is the tools' identity: the approve seam sees our wrapper rather than
	 * the host's own instance. The wrapper has the same name, the same dialect and
	 * the same behaviour; only the reference differs (ADR 0011 D81).
	 */
	let running = 0;

	/** How many provider calls of ours are in flight. */
	let calling = 0;

	/** The waiters for "our own calls are done". */
	const idle: (() => void)[] = [];

	/** Wakes the waiters when the last of our calls is done. */
	const wake = (): void => {
		if (running !== 0 || calling !== 0) return;
		const waiters = idle.splice(0);
		for (const waiter of waiters) waiter();
	};

	/** Resolves when none of our calls is running. */
	const whenIdle = (): Promise<void> =>
		running === 0 && calling === 0
			? Promise.resolve()
			: new Promise<void>((resolve) => {
					idle.push(resolve);
				});

	/**
	 * Our own tools, wrapped so that the receiving side can see them finish.
	 *
	 * The wrapper only counts: the name, the dialect and the behaviour are the host's
	 * (ADR 0011 D81).
	 */
	const tools = toolRegistry(
		[...config.tools.values()].map((tool) => ({
			...tool,
			execute: async (call, args, signal, report) => {
				running += 1;
				try {
					return await tool.execute(call, args, signal, report);
				} finally {
					running -= 1;
					wake();
				}
			},
		})),
	);

	/** Our own provider, wrapped so that the receiving side can see it let go. */
	const callProvider: HarnessHost["callProvider"] = (request, signal) => {
		const inner = host.callProvider(request, signal);
		return (async function* (): AsyncGenerator<ProviderEvent> {
			calling += 1;
			try {
				yield* inner;
			} finally {
				calling -= 1;
				wake();
			}
		})();
	};

	/**
	 * The host, with the provider call wrapped and the journal hook kept.
	 *
	 * The entries go to our host first — it is the one that keeps them — and then to
	 * the peer, as `event` frames, in the order they were written. **Our journal is
	 * the truth: the peer gets what we wrote** (ADR 0011 D81).
	 */
	const wired: HarnessHost = {
		...host,
		callProvider,
		append: (entry) => {
			try {
				host.append?.(entry);
			} catch (error) {
				// The journal hook failed: the entry was not written, so it is not
				// sent, and the task ends with a failure that says so. The entries
				// written before it did reach the peer.
				fail(`the journal could not be written: ${messageOf(error)}`);
				// A run whose journal cannot be written is a run nobody can check.
				controller.abort();
				return;
			}
			send({ kind: "event", taskId, event: entry });
			events.push(entry);
		},
	};

	/** Refuses the task, and tells the peer why. */
	const refuse = (reason: string, declaration?: string): void => {
		if (over) return;
		const refusal: Refusal = { reason, ...(declaration === undefined ? {} : { declaration }) };
		send({
			kind: "refuse",
			taskId,
			reason,
			...(declaration === undefined ? {} : { declaration }),
		});
		finish({ kind: "failed", error: refusal });
	};

	/** Whether the task was already taken: one offer, one run. */
	let taken = false;

	/**
	 * Runs the task with our own tools, and reports what happened.
	 *
	 * The outcome is the run's own: whatever the run ended with, verbatim. A run
	 * that ended without one — the host misbehaved — is a failure, and the failure
	 * is what the peer is told.
	 */
	const run = async (offer: OfferFrame): Promise<void> => {
		const stream = runAgent({ ...config, tools }, wired, {
			message: userMessage(promptOf(offer)),
			signal: controller.signal,
		});

		let result: Outcome = { kind: "failed", error: "the run ended without an outcome" };
		try {
			// The live events are ours alone — the peer reads the journal, not the
			// stream — so they are drained rather than left in the stream's buffer.
			for await (const event of stream) {
				if (event.type === "agent_end") result = event.outcome;
			}
		} catch (error) {
			result = { kind: "failed", error };
		}

		// The machine has ended the run, but our own work may not have: a tool that
		// was told to stop is still winding down, and the peer must not be told that
		// the task is over while it runs (ADR 0011 D62).
		await whenIdle();

		// The run has ended, and the core hands the host its last entries before
		// the terminal event — so the peer has heard every entry of the run before
		// it hears that the task is over.
		end(result);
	};

	/** Takes the task: the peer is told, and the run starts. */
	const take = (offer: OfferFrame): void => {
		if (taken || over) return;
		taken = true;
		if (offer.version !== protocolVersion) {
			// A peer of another version is refused, not half-understood.
			refuse(
				`the protocol version ${String(offer.version)} is not ours — this peer speaks version ${protocolVersion}`,
			);
			return;
		}
		if (typeof offer.task !== "string" || offer.task.trim() === "") {
			// An offer without a task is not a task: there is nothing to run.
			refuse("the offer carries no task — there is nothing to run");
			return;
		}

		let decision: TaskDecision;
		try {
			decision = decide?.(offer) ?? { kind: "accept" };
		} catch (error) {
			// A host that cannot decide is a refusal with a reason, not a silence:
			// the peer is told, and the task ends.
			refuse(`the host could not decide about the task: ${messageOf(error)}`);
			return;
		}
		if (decision.kind === "refuse") {
			refuse(stated(decision.reason), decision.declaration);
			return;
		}

		// The peer has to hear the accept before the run starts. A transport that
		// throws here ends the task — and the run never starts, because the peer
		// never heard that the task was taken (ADR 0011 D79).
		if (!send({ kind: "accept", taskId })) return;
		void run(offer);
	};

	port.onMessage((message) => {
		if (!isExchangeFrame(message)) return;
		const frame: ExchangeFrame = message;
		// A task that is not ours is not ours (ADR 0007 D43).
		if (frame.taskId !== taskId) return;

		switch (frame.kind) {
			case "offer":
				take(frame);
				return;
			case "cancel":
				if (!taken) {
					// The peer withdrew the task before offering it: it does not want
					// it, so no run starts, and the task ends.
					controller.abort();
					end({ kind: "cancelled" });
					return;
				}
				// The peer stopped the task: the run stops with it.
				controller.abort();
				return;
			case "accept":
			case "refuse":
			case "event":
			case "result":
				// The delegating side's frames. This side has nothing to do with them.
				return;
		}
	});

	return {
		events,
		outcome,
		cancel(): void {
			controller.abort();
		},
	};
}
