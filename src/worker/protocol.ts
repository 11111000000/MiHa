/**
 * The worker's wire protocol.
 *
 * One channel carries two kinds of traffic, and the frames are tagged so that each
 * side can tell what is its own: the **capability calls** the worker makes to the
 * host, and the **events** the host's application cares about.
 *
 * The frames are data. Nothing here is a function, so a channel may be a Web Worker,
 * a message port, or a pair of queues in a test.
 */

/** A capability the worker asks the host to perform. */
export interface CallFrame {
	readonly kind: "call";
	readonly id: string;
	readonly capability: string;
	readonly args: unknown;
}

/** The host's answer to one call. */
export interface AnswerFrame {
	readonly kind: "answer";
	readonly id: string;
	readonly ok: boolean;
	readonly value?: unknown;
	readonly error?: string;
}

/**
 * The bridge owns its own frames only.
 *
 * Everything else the application sends over the same channel is `unknown` as far as
 * the bridge is concerned: it passes such frames through and does not pretend to
 * understand them.
 */
export type UpFrame = CallFrame;
export type DownFrame = AnswerFrame;

/** The transport. One channel, one handler per side. */
export interface Channel {
	post(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
}

/** What a capability is: a function the host provides and the worker may call. */
export type CapabilityFn = (args: unknown) => unknown | Promise<unknown>;
