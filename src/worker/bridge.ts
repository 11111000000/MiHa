/**
 * The capability bridge.
 *
 * The worker cannot reach the DOM, the storage or the clipboard: those belong to the
 * host's thread. The bridge is how the worker asks for them — and it is a **closed
 * set**: only the capabilities the host registered are reachable.
 *
 * "Registered" means *the host's own entry*. The prototype chain is the language's,
 * not the host's, so `toString` is no more a capability here than `console` is.
 *
 * The transport exists on both sides; the bridge is the part that knows which frames
 * are its own.
 *
 * Two rules about the channel itself, because a channel is the one thing that can
 * fail without anyone noticing:
 *
 * - **A frame the channel cannot carry is a failure, not a crash.** The caller is
 *   told, rather than left waiting for an answer that cannot arrive.
 * - **The host never raises.** The host runs in the application's thread, where an
 *   unhandled rejection is the application's problem. A broken channel leaves the
 *   caller waiting, and that is the end of it.
 */

import type { AnswerFrame, CallFrame, CapabilityFn, Channel, UpFrame } from "./protocol.ts";

export interface CapabilityClient {
	/** Calls a capability of the host. Rejects when the host refuses or the capability fails. */
	call(capability: string, args?: unknown): Promise<unknown>;
}

export interface CapabilityHostOptions {
	readonly capabilities: Readonly<Record<string, CapabilityFn>>;
	/** Frames the host does not own — the application's own traffic. */
	readonly onOtherFrame?: (frame: unknown) => void;
}

export interface CapabilityClientOptions {
	/** Frames the worker does not own — the application's own traffic. */
	readonly onOtherFrame?: (frame: unknown) => void;
}

/**
 * The failure's own message, and nothing else.
 *
 * `error.message` for an error — not `String(error)`, which would dress it up as
 * `"Error: the disk is on fire"` and be something other than what failed. A failure
 * that is not an error is a value, and a value has a string of its own.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Posts a frame, and says whether it went.
 *
 * A channel may refuse a frame it cannot carry — a value that is not cloneable, for
 * instance. Nothing can be done about that here, so it is swallowed and turned into an
 * answer.
 */
function tryPost(port: Channel, frame: unknown): boolean {
	try {
		port.post(frame);
		return true;
	} catch {
		return false;
	}
}

/**
 * The worker side: a client that calls capabilities on the host.
 */
export function createCapabilityClient(
	port: Channel,
	options: CapabilityClientOptions = {},
): CapabilityClient {
	const byId = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
	let counter = 0;

	port.onMessage((message) => {
		const frame = message as AnswerFrame;
		if (frame?.kind !== "answer") {
			options.onOtherFrame?.(frame);
			return;
		}
		const pending = byId.get(frame.id);
		if (!pending) return;
		byId.delete(frame.id);
		if (frame.ok) pending.resolve(frame.value);
		else pending.reject(new Error(frame.error ?? "the capability failed"));
	});

	return {
		call(capability: string, args?: unknown): Promise<unknown> {
			const id = `c${(counter += 1)}`;
			return new Promise<unknown>((resolve, reject) => {
				byId.set(id, { resolve, reject });
				const frame = { kind: "call", id, capability, args };
				if (!tryPost(port, frame)) {
					byId.delete(id);
					reject(new Error("the arguments cannot be sent"));
				}
			});
		},
	};
}

/**
 * The host side: it performs the capabilities the worker asks for.
 */
export function createCapabilityHost(port: Channel, options: CapabilityHostOptions): void {
	// The host's table, seen as a closed set: only an own property of it is an entry
	// the host made.
	const capabilities = options.capabilities;

	port.onMessage((message) => {
		const frame = message as UpFrame;
		if (frame?.kind !== "call") {
			options.onOtherFrame?.(message);
			return;
		}
		// Only an own entry of the host's table is a registered capability. A plain
		// lookup would also find what the language puts on Object.prototype.
		const capability = Object.hasOwn(capabilities, frame.capability)
			? capabilities[frame.capability]
			: undefined;
		if (!capability) {
			send(port, {
				kind: "answer",
				id: frame.id,
				ok: false,
				error: `unknown capability "${frame.capability}"`,
			});
			return;
		}
		void Promise.resolve()
			.then(() => capability(frame.args))
			.then(
				(value) => send(port, { kind: "answer", id: frame.id, ok: true, value }),
				(error) => send(port, { kind: "answer", id: frame.id, ok: false, error: messageOf(error) }),
			);
	});
}

/**
 * Sends an answer, and falls back when the channel refuses the value.
 *
 * A result that cannot be carried is turned into an error answer, which can be
 * carried. When even that cannot go, the channel is broken and there is nobody to
 * tell — so nothing is.
 */
function send(port: Channel, frame: AnswerFrame): void {
	if (tryPost(port, frame)) return;
	if (!frame.ok) return;
	tryPost(port, {
		kind: "answer",
		id: frame.id,
		ok: false,
		error: "the result cannot be sent",
	});
}
