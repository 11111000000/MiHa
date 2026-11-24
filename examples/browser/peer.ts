/**
 * The peer link, in memory.
 *
 * The example's page may offer a task to a peer over an `ExchangePort`. The real
 * transport — a socket — is a parallel slice, so this module is the transport the
 * example runs on: a pair of ports that carry each other's frames.
 *
 * **The port is the seam, not this pair.** Everything above it speaks
 * `ExchangePort`, so dropping a WebSocket in means writing another implementation
 * of the same two methods and changing nothing above.
 *
 * The delivery is asynchronous, like a socket's: a frame posted now is read in the
 * next turn of the loop, so a listener that is registered after the post still
 * hears it. A port that delivered in place would let a frame arrive before the
 * side that should receive it was listening, and the exchange would lose a task.
 */

import type { ExchangePort } from "../../src/exchange/index.ts";

/** The two ends of one link. */
export interface PortPair {
	/** The end the delegating side holds. */
	readonly here: ExchangePort;
	/** The end the receiving side holds. */
	readonly there: ExchangePort;
}

/** A pair of ports that carry each other's frames. */
export function createPortPair(): PortPair {
	const handlers: {
		here: ((message: unknown) => void)[];
		there: ((message: unknown) => void)[];
	} = { here: [], there: [] };

	/** Hands a frame to the handlers of the other end, in the next turn of the loop. */
	const deliver = (to: "here" | "there", message: unknown): void => {
		queueMicrotask(() => {
			for (const handler of [...handlers[to]]) handler(message);
		});
	};

	const here: ExchangePort = {
		post(message: unknown) {
			deliver("there", message);
		},
		onMessage(handler: (message: unknown) => void) {
			handlers.here.push(handler);
		},
	};

	const there: ExchangePort = {
		post(message: unknown) {
			deliver("here", message);
		},
		onMessage(handler: (message: unknown) => void) {
			handlers.there.push(handler);
		},
	};

	return { here, there };
}
