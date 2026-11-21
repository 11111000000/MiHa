/**
 * The worker host.
 *
 * It owns the realm where the agent runs: it hands the worker its capabilities,
 * forwards the worker's events to the application, and can end the realm.
 *
 * Four laws, and they are the reason this module exists:
 *
 * - **The capability set is closed.** The worker reaches what the application
 *   registered and nothing else. The bridge enforces that, and the host hands the
 *   bridge nothing but the application's own table.
 * - **The events arrive in order.** The interface renders them, and a transcript
 *   rendered out of order is a lie.
 * - **Termination is final.** `worker.terminate()` is the only guaranteed hard
 *   stop, and after it the host answers nothing — there is nobody left to answer.
 * - **The host never raises.** It runs in the application's thread, where an
 *   unhandled rejection is the application's problem. A broken worker leaves the
 *   caller waiting, and that is the end of it.
 */

import type { AgentEvent } from "../core/events.ts";
import { createCapabilityHost } from "./bridge.ts";
import type { CapabilityFn, Channel } from "./protocol.ts";

/** The worker the host owns: enough of `Worker` to run the realm and to end it. */
export interface WorkerLike {
	postMessage(message: unknown): void;
	terminate(): void;
	onmessage: ((event: { data: unknown }) => void) | null;
}

export interface WorkerHostOptions {
	readonly capabilities: Readonly<Record<string, CapabilityFn>>;
	/** The worker's events, in the order they were sent. */
	readonly onEvent?: (event: AgentEvent) => void;
	/** Frames the host does not own — the application's own traffic. */
	readonly onOtherFrame?: (frame: unknown) => void;
}

export interface WorkerHost {
	/** The channel the application talks to the worker through. */
	readonly channel: Channel;
	terminate(): void;
}

/** The frame the worker posts to carry an event to the application. */
interface EventFrame {
	readonly kind: "event";
	readonly event: AgentEvent;
}

/**
 * Whether the frame carries an event the worker sent.
 *
 * The wire format is the core's own: `{ kind: "event", event }` — the shape the
 * run's outputs have. The tag and the payload's shape are checked; the payload's
 * *variant* is not, because the vocabulary of the events belongs to the core and
 * the worker is the host's own code: a malformed event is the worker's bug, not an
 * attack, and the host forwards what the wire format carries.
 */
function isEventFrame(frame: unknown): frame is EventFrame {
	if (typeof frame !== "object" || frame === null) return false;
	if (!("kind" in frame) || frame.kind !== "event") return false;
	if (!("event" in frame)) return false;
	const event = frame.event;
	return typeof event === "object" && event !== null && "type" in event && typeof event.type === "string";
}

/**
 * The host of one worker.
 *
 * The worker cannot reach the DOM, the storage or the clipboard: those belong to
 * this thread, and the bridge is how the worker asks for them. What is left here
 * is the realm itself — the messages, the events, and the end.
 */
export function createWorkerHost(worker: WorkerLike, options: WorkerHostOptions): WorkerHost {
	/** The listeners on the worker's channel: the bridge's, and the application's own. */
	const listeners: ((message: unknown) => void)[] = [];
	let alive = true;

	const channel: Channel = {
		post(message: unknown) {
			try {
				worker.postMessage(message);
			} catch {
				// A worker that refuses a message is broken, and a broken worker must not
				// break the application. There is nobody to tell besides the worker,
				// which is the one that failed.
			}
		},
		onMessage(handler: (message: unknown) => void) {
			listeners.push(handler);
		},
	};

	// `worker.onmessage` is one slot, and the host needs several listeners on it:
	// the bridge's and the application's own. The slot is filled once, with a
	// fan-out, and it is the fan-out that the end of the realm closes.
	worker.onmessage = (event) => {
		if (!alive) return;
		for (const listener of listeners) listener(event.data);
	};

	createCapabilityHost(channel, {
		capabilities: options.capabilities,
		onOtherFrame: (frame) => {
			if (isEventFrame(frame)) options.onEvent?.(frame.event);
			else options.onOtherFrame?.(frame);
		},
	});

	return {
		channel,
		terminate() {
			alive = false;
			listeners.length = 0;
			worker.onmessage = null;
			worker.terminate();
		},
	};
}
