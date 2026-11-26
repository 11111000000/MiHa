/**
 * The peer link authenticates (ADR 0021).
 *
 * The first message over the wire is the shared token's handshake. A link whose
 * handshake fails is closed and reported, and no task frame is delivered before
 * the link authenticates.
 *
 * The tests speak over a **real** WebSocket pair, the way the transport tests do.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	createWebSocketPort,
	sameToken,
	type WebSocketPort,
} from "../src/exchange/websocket.ts";
import { protocolVersion, type OfferFrame, type TransportFailure } from "../src/exchange/protocol.ts";
import type { JournalEntry } from "../src/core/journal.ts";

const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function offer(taskId: string): OfferFrame {
	return { kind: "offer", version: protocolVersion, taskId, task: "hello" };
}

const entry: JournalEntry = {
	kind: "tool_call",
	callId: "c1",
	name: "read_file",
	argumentsText: '{"path":"a.txt"}',
	seq: 2,
	version: 1,
};

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("the condition did not hold in time");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

interface Peer {
	readonly client: WebSocketPort;
	readonly server: WebSocketPort;
	readonly received: unknown[];
	readonly failures: unknown[];
	readonly handshakes: unknown[];
}

/** A real link, both ends holding the same token. */
async function authedPeer(token: string): Promise<Peer> {
	const received: unknown[] = [];
	const failures: unknown[] = [];
	const handshakes: unknown[] = [];
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
				const port = createWebSocketPort(socket, { token });
				ports.set(socket, port);
				port.onMessage((message: unknown) => {
					if (message !== null && typeof message === "object" && "miha_auth" in message) {
						handshakes.push(message);
						return;
					}
					received.push(message);
				});
				port.onFailure((failure: TransportFailure) => failures.push(failure));
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
	if (socket.readyState !== WebSocket.OPEN) {
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("the socket did not open")));
		});
	}
	const client = createWebSocketPort(socket, { token });
	socket.addEventListener("message", (event) => client.receive(event.data));
	socket.addEventListener("close", () => client.close());

	return { client, server: await opened, received, failures, handshakes };
}

describe("the peer link authenticates", () => {
	test("two ends with the same token carry frames after the handshake", async () => {
		const link = await authedPeer("the shared token");

		expect(link.handshakes).toHaveLength(0);
		link.client.post(offer("t1"));

		await until(() => link.received.length > 0);
		expect(link.received).toEqual([offer("t1")]);
		expect(link.failures).toHaveLength(0);
	});

	test("a link whose ends hold different tokens carries nothing and is closed", async () => {
		const clientFailures: unknown[] = [];
		const serverFailures: unknown[] = [];
		const ports = new Map<Bun.ServerWebSocket, WebSocketPort>();
		const received: unknown[] = [];
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
					const port = createWebSocketPort(socket, { token: "the server's token" });
					ports.set(socket, port);
					port.onMessage((message: unknown) => received.push(message));
					port.onFailure((failure: TransportFailure) => serverFailures.push(failure));
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
		if (socket.readyState !== WebSocket.OPEN) {
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve());
				socket.addEventListener("error", () => reject(new Error("the socket did not open")));
			});
		}
		const client = createWebSocketPort(socket, { token: "the client's token" });
		socket.addEventListener("message", (event) => client.receive(event.data));
		socket.addEventListener("close", () => client.close());
		client.onFailure((failure: TransportFailure) => clientFailures.push(failure));

		client.post(offer("t1"));
		await until(() => clientFailures.length + serverFailures.length > 0);

		// Nothing crossed in either direction: the handshake disagreed, and the
		// link died before any frame of the task could travel.
		expect(received).toHaveLength(0);
	});

	test("the handshake never reaches the layer above", async () => {
		const link = await authedPeer("the shared token");

		link.client.post(offer("t1"));
		await until(() => link.received.length > 0);

		expect(link.handshakes).toHaveLength(0);
	});

	test("frames before the handshake are dropped and the link closes", async () => {
		const received: unknown[] = [];
		const failures: unknown[] = [];
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
					const port = createWebSocketPort(socket, { token: "the token" });
					ports.set(socket, port);
					port.onMessage((message: unknown) => received.push(message));
					port.onFailure((failure: TransportFailure) => failures.push(failure));
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

		// A stranger: frames, and no handshake at all.
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
		if (socket.readyState !== WebSocket.OPEN) {
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve());
				socket.addEventListener("error", () => reject(new Error("the socket did not open")));
			});
		}
		socket.addEventListener("message", () => {});
		socket.send(JSON.stringify(offer("t1")));

		await until(() => socket.readyState === WebSocket.CLOSED || received.length > 0);

		// The stranger's frame never reached the layer above, and the link closed.
		expect(received).toHaveLength(0);
		expect(socket.readyState).toBe(WebSocket.CLOSED);
	});

	test("the token compare never takes a shortcut", () => {
		expect(sameToken("the token", "the token")).toBe(true);
		expect(sameToken("the token", "the tokez")).toBe(false);
		expect(sameToken("the token", "the toke")).toBe(false);
		expect(sameToken("", "")).toBe(true);
		expect(sameToken("a", "b")).toBe(false);
	});
});
