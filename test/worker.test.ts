import { describe, expect, test } from "bun:test";
import { createCapabilityClient, createCapabilityHost } from "../src/worker/bridge.ts";
import type { Channel } from "../src/worker/protocol.ts";

/**
 * A channel with a queue, so a message posted before the listener arrives is not lost.
 * That ordering is not an accident of the test: a worker that boots before the host
 * is listening must not lose its first capability call.
 */
function makeChannel(): Channel & { readonly received: unknown[] } {
	const handlers: ((message: unknown) => void)[] = [];
	const queue: unknown[] = [];
	const received: unknown[] = [];
	return {
		received,
		post(message: unknown) {
			received.push(message);
			if (handlers.length === 0) {
				queue.push(message);
				return;
			}
			for (const handler of handlers) handler(message);
		},
		onMessage(handler: (message: unknown) => void) {
			handlers.push(handler);
			while (queue.length > 0) {
				const message = queue.shift();
				handler(message);
			}
		},
	};
}

function pair(): { up: Channel; down: Channel } {
	const toWorker = makeChannel();
	const toHost = makeChannel();
	return {
		up: {
			post: (message) => toHost.post(message),
			onMessage: (handler) => toWorker.onMessage(handler),
		},
		down: {
			post: (message) => toWorker.post(message),
			onMessage: (handler) => toHost.onMessage(handler),
		},
	};
}

/** A channel that behaves like a structured clone: it refuses what it cannot carry. */
function strictChannel(): Channel {
	const handlers: ((message: unknown) => void)[] = [];
	const queue: unknown[] = [];
	return {
		post(message: unknown) {
			structuredClone(message);
			if (handlers.length === 0) {
				queue.push(message);
				return;
			}
			for (const handler of handlers) handler(message);
		},
		onMessage(handler: (message: unknown) => void) {
			handlers.push(handler);
			while (queue.length > 0) handler(queue.shift());
		},
	};
}

function strictPair(): { up: Channel; down: Channel } {
	const toWorker = strictChannel();
	const toHost = strictChannel();
	return {
		up: { post: (message) => toHost.post(message), onMessage: (handler) => toWorker.onMessage(handler) },
		down: { post: (message) => toWorker.post(message), onMessage: (handler) => toHost.onMessage(handler) },
	};
}

describe("the capability bridge", () => {
	test("a registered capability is reachable and its value comes back", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, { capabilities: { double: (args) => (args as { n: number }).n * 2 } });

		const client = createCapabilityClient(up);
		expect(await client.call("double", { n: 21 })).toBe(42);
	});

	test("an unknown capability is refused", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, { capabilities: { double: (args) => (args as { n: number }).n * 2 } });

		const client = createCapabilityClient(up);
		await expect(client.call("triple", { n: 1 })).rejects.toThrow(/triple/);
	});

	test("a capability that fails rejects with the failure's message", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, {
			capabilities: {
				explode: () => {
					throw new Error("the disk is on fire");
				},
			},
		});

		const client = createCapabilityClient(up);
		await expect(client.call("explode")).rejects.toThrow("the disk is on fire");
	});

	test("a capability that rejects rejects with the failure's message", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, {
			capabilities: {
				explode: async () => {
					throw new Error("the network is down");
				},
			},
		});

		const client = createCapabilityClient(up);
		await expect(client.call("explode")).rejects.toThrow("the network is down");
	});

	test("two concurrent calls each get their own answer", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, {
			capabilities: {
				slow: async (args) => {
					const { n, wait } = args as { n: number; wait: number };
					await new Promise((resolve) => setTimeout(resolve, wait));
					return n;
				},
			},
		});

		const client = createCapabilityClient(up);
		const [first, second] = await Promise.all([
			client.call("slow", { n: 1, wait: 30 }),
			client.call("slow", { n: 2, wait: 1 }),
		]);
		expect(first).toBe(1);
		expect(second).toBe(2);
	});

	test("a result the channel cannot carry fails the call instead of hanging it", async () => {
		const { up, down } = strictPair();
		createCapabilityHost(down, {
			capabilities: { uncarryable: () => () => {} },
		});

		const client = createCapabilityClient(up);
		await expect(client.call("uncarryable")).rejects.toThrow(/cannot be sent|can not be cloned|cannot carry/i);
	});

	test("an argument the channel cannot carry rejects the call", async () => {
		const { up, down } = strictPair();
		createCapabilityHost(down, { capabilities: { anything: () => 1 } });

		const client = createCapabilityClient(up);
		await expect(client.call("anything", () => {})).rejects.toThrow(/cannot be sent/);
	});

	test("a call is answered exactly once", async () => {
		const { up, down } = pair();
		const answered: unknown[] = [];
		const counting = {
			post: (message: unknown) => {
				const frame = message as { kind?: string };
				if (frame?.kind === "answer") answered.push(message);
				down.post(message);
			},
			onMessage: (handler: (message: unknown) => void) => down.onMessage(handler),
		};

		createCapabilityHost(counting, {
			capabilities: {
				fine: () => 1,
				explode: () => {
					throw new Error("no");
				},
			},
		});

		const client = createCapabilityClient(up);
		await client.call("fine");
		await client.call("explode").catch(() => undefined);
		await client.call("nowhere").catch(() => undefined);

		expect(answered).toHaveLength(3);
	});

	test("a broken channel leaves the host silent and raises nothing", async () => {
		const handlers: ((message: unknown) => void)[] = [];
		const broken: Channel = {
			post: () => {
				throw new Error("the channel is broken");
			},
			onMessage: (handler) => {
				handlers.push(handler);
			},
		};

		let raised: unknown;
		const onUnhandled = (reason: unknown) => {
			raised = reason;
		};
		process.on("unhandledRejection", onUnhandled);

		createCapabilityHost(broken, { capabilities: { boom: () => 1 } });
		handlers[0]?.({ kind: "call", id: "c1", capability: "boom", args: null });
		await new Promise((resolve) => setTimeout(resolve, 20));

		process.off("unhandledRejection", onUnhandled);
		expect(raised).toBeUndefined();
	});

	test("a frame the bridge does not own reaches the application", () => {
		const { up, down } = pair();
		const others: unknown[] = [];
		createCapabilityHost(down, { capabilities: {}, onOtherFrame: (frame) => others.push(frame) });

		// The frame travels from the worker up to the host, so it is posted on the
		// worker's channel.
		up.post({ kind: "event", event: { type: "agent_start" } });
		expect(others).toEqual([{ kind: "event", event: { type: "agent_start" } }]);
	});
});
