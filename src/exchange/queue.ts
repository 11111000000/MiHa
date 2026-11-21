/**
 * A queue of agent events.
 *
 * The delegating side receives the peer's events over a channel and hands them to the
 * application as a stream. The channel delivers them one at a time and the
 * application consumes them at its own pace, so something has to hold the gap.
 *
 * It is deliberately not the core's `EventStream`: that one is closed by a terminal
 * *event*, and here the stream is closed by the **task** ending, which may come before
 * or after the peer's last event.
 */

import type { AgentEvent } from "../core/events.ts";

export class AgentEventQueue implements AsyncIterable<AgentEvent> {
	#items: AgentEvent[] = [];
	#waiters: (() => void)[] = [];
	#closed = false;

	get closed(): boolean {
		return this.#closed;
	}

	push(event: AgentEvent): void {
		if (this.#closed) return;
		this.#items.push(event);
		this.#wake();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#wake();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
		for (;;) {
			if (this.#items.length > 0) {
				const event = this.#items.shift();
				if (event !== undefined) yield event;
				continue;
			}
			if (this.#closed) return;
			await new Promise<void>((resolve) => {
				this.#waiters.push(resolve);
			});
		}
	}

	#wake(): void {
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const waiter of waiters) waiter();
	}
}
