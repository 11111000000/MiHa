/**
 * The worker's entry: the harness, in the realm.
 *
 * The worker has no DOM and no storage. It has the channel to the page, and the
 * harness. This file is the whole of the binding: the channel is the worker's
 * global scope, and the application is the harness plus the page's requests.
 */

import type { Channel } from "../../src/worker/protocol.ts";
import { minimaxProvider, MINIMAX_OPTIONS, MODEL } from "./provider.ts";
import { createWorkerApp } from "./worker.ts";

/**
 * The part of the worker's global scope the entry uses.
 *
 * A module worker has `postMessage` and `message` events; the page's `window` has
 * a `postMessage` of its own with a different signature, so the scope is declared
 * here rather than taken from the ambient `self`.
 */
interface WorkerScope {
	postMessage(message: unknown): void;
	addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const channel: Channel = {
	post(message: unknown) {
		scope.postMessage(message);
	},
	onMessage(handler: (message: unknown) => void) {
		scope.addEventListener("message", (event) => {
			handler(event.data);
		});
	},
};

createWorkerApp(channel, {
	provider: minimaxProvider,
	model: MODEL,
	wireOptions: MINIMAX_OPTIONS,
});
