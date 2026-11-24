/**
 * The peer's transport over a WebSocket.
 *
 * The tests speak over a **real** WebSocket: a server on the loopback interface,
 * on a port the operating system picks, and a client that is the browser's own
 * `WebSocket`. A transport that has only ever been met in a double is a transport
 * whose ordering nobody has seen, and ordering is the whole of this claim.
 *
 * The doubles appear only where a real socket cannot be made to misbehave on
 * demand: a socket that throws when it is sent on, and a socket that is closed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { delegate } from "../src/exchange/delegate.ts";
import { receive } from "../src/exchange/receive.ts";
import {
	isExchangeFrame,
	protocolVersion,
	type ExchangeFrame,
	type OfferFrame,
	type TransportFailure,
} from "../src/exchange/protocol.ts";
import { createWebSocketPort, type ExchangeSocket, type WebSocketPort } from "../src/exchange/websocket.ts";
import { toolRegistry } from "../src/core/tools.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import type { HarnessConfig } from "../src/core/run.ts";
import type { JournalEntry } from "../src/core/journal.ts";

/** The servers the tests opened, so that a failing test leaves none listening. */
const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

/** The frame the test sends: the offer, with the protocol's own version. */
function offer(taskId: string, task: string): OfferFrame {
	return { kind: "offer", version: protocolVersion, taskId, task };
}

/** A journal entry, as an `event` frame carries it. */
const entry: JournalEntry = {
	kind: "tool_call",
	callId: "c1",
	name: "read_file",
	argumentsText: '{"path":"a.txt"}',
	seq: 2,
	version: 1,
};

/** Waits until the predicate holds, and fails when it does not. */
async function until(predicate: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("the condition did not hold in time");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

/** Waits for a promise to settle, and fails when it does not. */
async function settles<T>(promise: Promise<T>, ms = 2000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`the promise did not settle within ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** The two ends of one link. */
interface Peer {
	/** The frontend's end. */
	readonly client: WebSocketPort;
	/** The backend's end. */
	readonly server: WebSocketPort;
}

/** Waits until the socket is open. */
function whenOpen(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("the socket did not open")));
	});
}

/**
 * A local peer: a real server and a real client, over the loopback interface.
 *
 * The server listens on port 0 — the operating system picks a free one — so a test
 * never collides with anything that is already listening.
 */
async function peer(): Promise<Peer> {
	const ports = new Map<Bun.ServerWebSocket, WebSocketPort>();
	let announce: (port: WebSocketPort) => void = () => {};
	const opened = new Promise<WebSocketPort>((resolve) => {
		announce = resolve;
	});

	const server = Bun.serve({
		port: 0,
		fetch(request, instance) {
			if (instance.upgrade(request)) return undefined;
			return new Response("not a websocket", { status: 400 });
		},
		websocket: {
			open(socket) {
				const port = createWebSocketPort(socket);
				ports.set(socket, port);
				announce(port);
			},
			message(socket, message) {
				ports.get(socket)?.receive(message);
			},
			close(socket) {
				ports.get(socket)?.close();
			},
		},
	});
	servers.push(server);

	const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
	await whenOpen(socket);

	const client = createWebSocketPort(socket);
	socket.addEventListener("message", (event) => client.receive(event.data));
	socket.addEventListener("close", () => client.close());

	return { client, server: await opened };
}

/** A socket that is closed: nothing can be sent on it, and sending says nothing. */
function closedSocket(): ExchangeSocket {
	return {
		readyState: 3,
		send() {},
		close() {},
	};
}

/** A socket that is broken: it is open, and sending on it throws. */
function brokenSocket(): ExchangeSocket {
	return {
		readyState: 1,
		send() {
			throw new Error("the socket is broken");
		},
		close() {},
	};
}

/** A socket that remembers what was sent on it. */
function recordingSocket(sent: string[]): ExchangeSocket {
	return {
		readyState: 1,
		send(data) {
			sent.push(data);
		},
		close() {},
	};
}

describe("the peer's transport over a WebSocket", () => {
	test("a frame that is sent arrives once and in order", async () => {
		const peers = await peer();
		const received: unknown[] = [];
		peers.server.onMessage((message) => received.push(message));

		peers.client.post(offer("t1", "first"));
		peers.client.post(offer("t2", "second"));
		peers.client.post(offer("t3", "third"));

		await until(() => received.length === 3);
		expect(received).toEqual([offer("t1", "first"), offer("t2", "second"), offer("t3", "third")]);
	});

	test("a frame that arrives is delivered to every listener", async () => {
		const peers = await peer();
		const first: unknown[] = [];
		const second: unknown[] = [];
		peers.server.onMessage((message) => first.push(message));
		peers.server.onMessage((message) => second.push(message));

		peers.client.post(offer("t1", "only"));

		await until(() => first.length === 1 && second.length === 1);
		expect(first).toEqual([offer("t1", "only")]);
		expect(second).toEqual(first);
	});

	test("and to nobody else", async () => {
		const peers = await peer();
		const other = await peer();
		const mine: unknown[] = [];
		const theirs: unknown[] = [];
		peers.server.onMessage((message) => mine.push(message));
		other.server.onMessage((message) => theirs.push(message));

		peers.client.post(offer("t1", "mine"));

		await until(() => mine.length === 1);
		expect(theirs).toEqual([]);
	});

	test("the frames travel unchanged", async () => {
		const peers = await peer();
		const received: unknown[] = [];
		peers.server.onMessage((message) => received.push(message));

		const frame: ExchangeFrame = { kind: "event", taskId: "t1", event: entry };

		peers.client.post(frame);

		await until(() => received.length === 1);
		expect(received[0]).toEqual(frame);
		expect(isExchangeFrame(received[0])).toBe(true);
	});

	test("the backend end is the same port", async () => {
		const peers = await peer();
		const received: unknown[] = [];
		peers.client.onMessage((message) => received.push(message));

		peers.server.post(offer("t1", "from the backend"));

		await until(() => received.length === 1);
		expect(received).toEqual([offer("t1", "from the backend")]);
	});

	test("a frame the layer does not know is left to the layer", async () => {
		const peers = await peer();
		const task = delegate({ port: peers.client, taskId: "t1", task: "read a.txt" });
		const entries: JournalEntry[] = [];
		const drained = (async () => {
			for await (const entry of task.events) entries.push(entry);
		})();

		// A frame of another protocol, and then the answer.
		peers.server.post({ kind: "call", taskId: "t1", callId: "c1", tool: "read_file", args: {} });
		peers.server.post({ kind: "result", taskId: "t1", outcome: { kind: "completed" } });

		expect(await settles(task.outcome)).toEqual({ kind: "completed" });
		expect(entries).toEqual([]);
		await drained;
	});

	test("a frame of another task is not this task's", async () => {
		const peers = await peer();
		const task = delegate({ port: peers.client, taskId: "t1", task: "read a.txt" });
		const entries: JournalEntry[] = [];
		const drained = (async () => {
			for await (const entry of task.events) entries.push(entry);
		})();

		peers.server.post({ kind: "event", taskId: "other", event: entry });
		peers.server.post({ kind: "event", taskId: "t1", event: entry });
		peers.server.post({ kind: "result", taskId: "t1", outcome: { kind: "completed" } });

		expect(await settles(task.outcome)).toEqual({ kind: "completed" });
		expect(entries).toEqual([entry]);
		await drained;
	});

	test("a frame that cannot be sent is reported rather than thrown", () => {
		const failures: TransportFailure[] = [];
		const port = createWebSocketPort(brokenSocket());
		port.onFailure((failure) => failures.push(failure));

		expect(() => port.post(offer("t1", "doomed"))).not.toThrow();

		expect(failures).toHaveLength(1);
		expect(failures[0]?.error.message).toContain("broken");
		expect(failures[0]?.frame).toEqual(offer("t1", "doomed"));
	});

	test("a socket that is not open reports the frame instead of losing it", () => {
		const failures: TransportFailure[] = [];
		const port = createWebSocketPort(closedSocket());
		port.onFailure((failure) => failures.push(failure));

		port.post(offer("t1", "doomed"));

		expect(failures).toHaveLength(1);
		expect(failures[0]?.frame).toEqual(offer("t1", "doomed"));
	});

	test("a closed port sends nothing", () => {
		const sent: string[] = [];
		const failures: TransportFailure[] = [];
		const port = createWebSocketPort(recordingSocket(sent));
		port.onFailure((failure) => failures.push(failure));

		port.close();
		port.post(offer("t1", "after the end"));

		expect(sent).toEqual([]);
		expect(failures).toHaveLength(1);
	});

	test("and delivers nothing more", async () => {
		const peers = await peer();
		const received: unknown[] = [];
		peers.client.onMessage((message) => received.push(message));

		peers.client.close();
		peers.client.receive(JSON.stringify(offer("t1", "late")));

		expect(received).toEqual([]);
	});

	test("and a listener that joins a closed port hears nothing", async () => {
		const peers = await peer();
		const received: unknown[] = [];

		peers.client.close();
		peers.client.onMessage((message) => received.push(message));
		peers.client.receive(JSON.stringify(offer("t1", "later")));

		expect(received).toEqual([]);
	});

	test("the delegating side ends the task when the transport reports a failure", async () => {
		const port = createWebSocketPort(brokenSocket());
		const task = delegate({ port, taskId: "t1", task: "read a.txt" });

		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(outcome.kind === "failed" ? outcome.error : undefined).toContain("could not be reached");
	});

	test("the receiving side ends the task when the transport reports a failure", async () => {
		const port = createWebSocketPort(brokenSocket());
		const task = receive({ port, taskId: "t1", config: config(), host: host() });

		port.receive(JSON.stringify(offer("t1", "read a.txt")));

		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(outcome.kind === "failed" ? outcome.error : undefined).toContain("could not be reached");
	});
});

/** A configuration with no tools: the run must not start at all. */
function config(): HarnessConfig {
	return { model: "test-model", system: "you are a test", tools: toolRegistry([]), turnLimit: 4 };
}

/** A host whose provider fails the test if it is ever called. */
function host(): HarnessHost {
	return {
		callProvider: async function* () {
			throw new Error("the run must not start");
		},
	};
}

describe("the port's own edges", () => {
	test("a frame that cannot be encoded is reported, not thrown", () => {
		const failures: unknown[] = [];
		const port = createWebSocketPort({
			send: () => {},
			close: () => {},
			readyState: 1,
		});
		port.onFailure?.((failure) => failures.push(failure));
		const cyclic: Record<string, unknown> = {};
		cyclic["self"] = cyclic;

		expect(() => port.post(cyclic)).not.toThrow();
		expect(failures).toHaveLength(1);
	});

	test("a message that is not JSON is handed over as it is, not thrown", () => {
		const received: unknown[] = [];
		const port = createWebSocketPort({
			send: () => {},
			close: () => {},
			readyState: 1,
		});
		port.onMessage((message) => received.push(message));

		expect(() => port.receive("not json at all")).not.toThrow();
		expect(received).toHaveLength(1);
		expect(received[0]).toBe("not json at all");
	});

	test("a failure handler that throws does not make the port throw", () => {
		const port = createWebSocketPort({
			send: () => {},
			close: () => {},
			readyState: 1,
		});
		port.onFailure?.(() => {
			throw new Error("the handler is broken");
		});
		expect(() => port.post({ kind: "accept", taskId: "t1" })).not.toThrow();
	});

	test("a listener that throws does not stop the delivery to the others", () => {
		const received: unknown[] = [];
		const port = createWebSocketPort({
			send: () => {},
			close: () => {},
			readyState: 1,
		});
		port.onMessage(() => {
			throw new Error("this listener is broken");
		});
		port.onMessage((message) => received.push(message));

		expect(() => port.receive('{"kind":"accept","taskId":"t1"}')).not.toThrow();
		expect(received).toHaveLength(1);
	});

	test("closing the port closes the socket under it", () => {
		let closed = false;
		const port = createWebSocketPort({
			send: () => {},
			close: () => {
				closed = true;
			},
			readyState: 1,
		});
		port.close();
		expect(closed).toBe(true);
	});
});
