/**
 * The peer's transport over a WebSocket.
 *
 * The exchange had a protocol and no way to speak it: `ExchangePort` was an
 * interface nothing implemented, and a frontend and a backend could not talk. This
 * module is the transport — the one link the two peers share.
 *
 * **The port is not the protocol.** The frames travel unchanged: the port encodes
 * them as JSON and hands them over, and `isExchangeFrame` is the only gate. A
 * frame the layer above does not know is the layer above's business, and a
 * message that is not JSON at all is handed over as it is, so that the gate — and
 * not the transport — decides what is a frame (ADR 0007 D43).
 *
 * **The port never throws.** A frame that cannot be carried is *reported*: the
 * socket is closed, the socket breaks, the frame cannot be encoded, and the
 * port says so on its failure channel. A broken link must not take the run down,
 * and the layer above decides what the failure means (ADR 0011 D79) — the
 * delegating side ends the task, the receiving side ends the task, and neither
 * of them waits for an answer that is not coming.
 *
 * **The socket is somebody else's.** The port takes the part of a WebSocket it
 * uses — send, close, and whether it is open — and nothing else. The browser's
 * `WebSocket`, Node's, Bun's own and a server's socket all satisfy it, and the
 * library depends on none of them. What arrives is handed to the port by the
 * host, because the browser's socket and a server's socket deliver their
 * messages differently, and that difference is the host's business and not the
 * transport's.
 */

import type { ExchangePort, TransportFailure } from "./protocol.ts";

const encoder = new TextEncoder();

/**
 * Whether two tokens are equal, without an early exit on the first difference.
 *
 * A compare that bails out on the first differing byte lets a peer measure how
 * much of the token it guessed — the link would leak its own secret through
 * timing (ADR 0021 D112).
 */
export function sameToken(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	let diff = left.length ^ right.length;
	const n = Math.min(left.length, right.length);
	for (let index = 0; index < n; index += 1) {
		diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return diff === 0;
}

/** The socket's state when it can carry a frame. The WebSocket API's own number. */
const OPEN = 1;

/**
 * The socket a port speaks over — the part of a WebSocket the port uses.
 *
 * The methods are methods and not properties on purpose: a browser's `WebSocket`
 * sends a wider type than a string, and a method is what makes the two the same
 * shape to TypeScript.
 */
export interface ExchangeSocket {
	/** Sends one text frame. Throws when the socket cannot carry it. */
	send(data: string): void;
	/** Closes the socket. */
	close(code?: number, reason?: string): void;
	/** The socket's state: `1` is open. */
	readonly readyState: number;
}

/** A port that speaks over a WebSocket. */
export interface WebSocketPort extends ExchangePort {
	/**
	 * Subscribes to the transport's failures.
	 *
	 * A port over a socket always has this channel: the socket may break, and a
	 * frame that cannot be carried is reported and never thrown.
	 */
	onFailure(handler: (failure: TransportFailure) => void): void;
	/**
	 * Hands the port what arrived on the socket.
	 *
	 * The host calls this: the socket's own event model is the host's, and the
	 * browser's and a server's differ.
	 */
	receive(data: unknown): void;
	/**
	 * Closes the port, and the socket under it.
	 *
	 * After this the port sends nothing and delivers nothing more.
	 */
	close(): void;
}

/** The shared secret of the link: both ends hold the same token (ADR 0021 D111). */
export interface AuthOptions {
	readonly token: string;
}

/**
 * How a link authenticates (ADR 0021).
 *
 * - The port with a token opens with a handshake message — the shared token —
 *   before anything the layer above sends.
 * - Until the peer's handshake arrives, incoming frames are dropped, the link is
 *   closed, and the failure is reported once.
 * - A handshake with the wrong token closes the link and is reported.
 * - The handshake never reaches the layer above: it carries the secret.
 */
export interface AuthenticatedOptions extends AuthOptions {}

/**
 * The port over one socket.
 *
 * The socket is the port's only way out, and the port is the only thing that
 * speaks to it: the frames are encoded once, in one place, and every listener
 * sees the same frame in the same order.
 */
export function createWebSocketPort(socket: ExchangeSocket, auth?: AuthOptions): WebSocketPort {
	/** The listeners on the port: one channel, many listeners. */
	const listeners: ((message: unknown) => void)[] = [];

	/** The handlers that hear about a frame that could not be carried. */
	const failures: ((failure: TransportFailure) => void)[] = [];

	/** Whether the port is still open. A closed port is closed for good. */
	let open = true;

	/**
	 * Whether the link authenticated: the peer's handshake matched the token, and
	 * the frames the layer above sends may cross. A link without a token carries
	 * whatever both ends agreed to carry — trusted channels (ADR 0020 D108).
	 */
	let authenticated = auth === undefined;

	/** The link's own handshake, sent once, before any frame of the task. */
	let helloSent = auth === undefined;

	const sendHello = (): void => {
		if (helloSent || !open || socket.readyState !== OPEN) return;
		helloSent = true;
		const text = encode({ miha_auth: auth?.token ?? "" });
		if (text !== undefined) {
			try {
				socket.send(text);
			} catch {
				// The handshake could not go: the first real frame will say so on
				// the peer's side, and the failure channel hears about this one.
				report({ error: new Error("the handshake could not be sent"), frame: undefined });
			}
		}
	};

	/**
	 * Whether a decoded message is the peer's half of the handshake.
	 *
	 * The handshake is a transport message, not a protocol frame: it carries no
	 * `kind`, and the layer above never sees it — it carries the secret.
	 */
	const isHandshake = (message: unknown): message is { miha_auth: string } =>
		message !== null &&
		typeof message === "object" &&
		"miha_auth" in message &&
		typeof (message as { miha_auth: unknown }).miha_auth === "string";

	/** Consumes the peer's handshake. Says whether the link authenticated. */
	const takeHandshake = (message: { miha_auth: string }): boolean =>
		sameToken(message.miha_auth, auth?.token ?? "");

	/** Closes the port and the socket under it. */
	const closePort = (): void => {
		if (!open) return;
		open = false;
		listeners.length = 0;
		try {
			socket.close();
		} catch {
			// A socket that cannot be closed is broken, and a broken socket is
			// closed either way: the port is what the caller holds.
		}
	};

	/** Tells the layer above that a frame did not go. */
	const report = (failure: TransportFailure): void => {
		// A copy: a handler joins from now on, and it has not heard about the
		// failures that came before it. A handler that throws must not make the
		// port throw: the port's law is that it reports, never that it raises
		// (ADR 0011 D79).
		for (const handler of [...failures]) {
			try {
				handler(failure);
			} catch {
				// The handler is broken; the frame is still lost, and the run must
				// not die of it.
			}
		}
	};

	return {
		post(message: unknown): void {
			sendHello();
			if (!open) {
				report({ error: new Error("the port is closed"), frame: message });
				return;
			}
			if (socket.readyState !== OPEN) {
				// The socket cannot carry the frame, and a socket that is not open
				// may not even say so: a server's socket drops a frame that is sent
				// on a closed connection without a sound.
				report({ error: new Error("the socket is not open"), frame: message });
				return;
			}
			const text = encode(message);
			if (text === undefined) {
				report({ error: new Error("the frame cannot be encoded as JSON"), frame: message });
				return;
			}
			try {
				socket.send(text);
			} catch (error) {
				report({ error: asError(error), frame: message });
			}
		},

		onMessage(handler: (message: unknown) => void): void {
			listeners.push(handler);
		},

		onFailure(handler: (failure: TransportFailure) => void): void {
			failures.push(handler);
		},

		receive(data: unknown): void {
			if (!open) return;
			const message = decode(data);
			if (auth !== undefined) {
				if (isHandshake(message)) {
					// The peer's half of the handshake. It is consumed here, and it
					// never reaches the layer above: the secret stays in the wire's
					// one trip (ADR 0021 D110).
					authenticated = takeHandshake(message);
					if (!authenticated) {
						report({ error: new Error("the link is not authenticated"), frame: message });
						closePort();
					}
					return;
				}
				if (!authenticated) {
					// A frame from a peer that never proved itself: dropped, the
					// link closed, and the failure reported once (ADR 0021 D110).
					report({ error: new Error("the link is not authenticated"), frame: message });
					closePort();
					return;
				}
			}
			// The live list, like the worker's channel: a listener that closes the
			// port empties the list, and the delivery stops there.
			for (const listener of [...listeners]) {
			// A listener that throws must not stop the delivery to the others: the
			// frame reached the port, and it reaches everyone (ADR 0017 D100).
			try {
				listener(message);
			} catch {
				// This listener is broken; the others still hear the frame.
			}
		}
		},

		close(): void {
			closePort();
		},
	};
}

/**
 * The frame as the wire carries it.
 *
 * `undefined` when the frame has no JSON form — a function, `undefined`, or a
 * cycle. Such a frame cannot be sent, and the port says so rather than sending
 * something the peer would read as a different frame.
 */
function encode(message: unknown): string | undefined {
	try {
		const text = JSON.stringify(message);
		return typeof text === "string" ? text : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The message as the port delivers it.
 *
 * The wire carries JSON, and the port hands the layer above what the text says.
 * Text that is not JSON is handed over as it is: the transport is not the
 * protocol, and the layer above ignores what it does not know.
 */
function decode(data: unknown): unknown {
	if (typeof data !== "string") return data;
	try {
		return JSON.parse(data) as unknown;
	} catch {
		return data;
	}
}

/** The failure as an error, whatever the socket threw. */
function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
