/**
 * A queue of journal entries.
 *
 * The delegating side receives the peer's entries over a channel and hands them to
 * the application as a stream. The channel delivers them one at a time and the
 * application consumes them at its own pace, so something has to hold the gap.
 *
 * It is deliberately not the core's `EventStream`: that one is closed by a terminal
 * *event*, and here the stream is closed by the **task** ending, which may come before
 * or after the peer's last entry.
 */

import type { JournalEntry } from "../core/journal.ts";

export class JournalEntryQueue implements AsyncIterable<JournalEntry> {
	#items: JournalEntry[] = [];
	#waiters: (() => void)[] = [];
	#closed = false;

	get closed(): boolean {
		return this.#closed;
	}

	push(entry: JournalEntry): void {
		if (this.#closed) return;
		this.#items.push(entry);
		this.#wake();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#wake();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<JournalEntry> {
		for (;;) {
			if (this.#items.length > 0) {
				const entry = this.#items.shift();
				if (entry !== undefined) yield entry;
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
