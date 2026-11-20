/**
 * The event stream.
 *
 * One primitive, five laws. The laws are the contract; the tests are their proof.
 *
 *   S1  events are delivered in push order, each exactly once
 *   S2  result() resolves exactly once, with the value extracted from the terminal event
 *   S3  events pushed after the terminal event are ignored
 *   S4  iteration ends after the terminal event has been delivered
 *   S5  no event is lost between a push and the start of iteration
 *
 * The stream is the only channel between the core and the outside world. There is no
 * second error channel: a failure is a value in the stream, not an exception thrown
 * beside it.
 */

export type StreamTerminal<T, R> = {
	/** Decides whether an event ends the stream. */
	readonly isTerminal: (event: T) => boolean;
	/** Extracts the result value from the terminal event. */
	readonly extract: (event: T) => R;
};

export class EventStream<T, R> implements AsyncIterable<T> {
	#buffer: T[] = [];
	#waiters: Array<() => void> = [];
	#closed = false;
	#failure: { readonly error: unknown } | undefined;

	readonly #terminal: StreamTerminal<T, R>;
	readonly #resultPromise: Promise<R>;
	#resolveResult!: (value: R) => void;
	#rejectResult!: (reason: unknown) => void;

	constructor(terminal: StreamTerminal<T, R>) {
		this.#terminal = terminal;
		this.#resultPromise = new Promise<R>((resolve, reject) => {
			this.#resolveResult = resolve;
			this.#rejectResult = reject;
		});
		// A stream nobody awaits must not raise an unhandled rejection.
		this.#resultPromise.catch(() => {});
	}

	/** True once the terminal event has been accepted, or the stream has been closed. */
	get closed(): boolean {
		return this.#closed;
	}

	/**
	 * Publishes an event. Ignored after the stream is closed (S3).
	 */
	push(event: T): void {
		if (this.#closed) return;
		if (this.#terminal.isTerminal(event)) {
			this.#closed = true;
			this.#resolveResult(this.#terminal.extract(event));
		}
		this.#buffer.push(event);
		this.#wake();
	}

	/**
	 * Fails the stream. Iteration and `result()` reject with `error`.
	 *
	 * Used for failures that are *not* part of the protocol — a bug in an adapter, a
	 * host callback that threw. A provider failure is an event, not a failure here.
	 */
	fail(error: unknown): void {
		if (this.#closed) return;
		this.#failure = { error };
		this.#closed = true;
		this.#rejectResult(error);
		this.#wake();
	}

	/**
	 * Closes the stream without a terminal event. `result()` rejects rather than
	 * hanging, so a producer bug surfaces instead of stalling the host.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#rejectResult(new Error("EventStream closed without a terminal event"));
		this.#wake();
	}

	/** Resolves with the value extracted from the terminal event (S2). */
	result(): Promise<R> {
		return this.#resultPromise;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		for (;;) {
			if (this.#buffer.length > 0) {
				yield this.#buffer.shift() as T;
				continue;
			}
			if (this.#failure) throw this.#failure.error;
			if (this.#closed) return;
			await new Promise<void>((resolve) => {
				this.#waiters.push(resolve);
			});
		}
	}

	#wake(): void {
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const resolve of waiters) resolve();
	}
}

/**
 * Creates a stream whose terminal event is the one carrying `type === "agent_end"`.
 */
export function createAgentEventStream<T extends { type: string }, M>(): EventStream<
	T,
	readonly M[] | undefined
> {
	return new EventStream<T, readonly M[] | undefined>({
		isTerminal: (event) => event.type === "agent_end",
		extract: (event) => (event as unknown as { messages: readonly M[] }).messages,
	});
}
