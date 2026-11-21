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

/**
 * A promise that is supposed to settle, raced against a short timer.
 *
 * Bun's per-test timeout does not fire on a promise that never settles: the await
 * simply waits, and the whole run hangs. A hung gate is worse than a failing one, so
 * every promise that must settle goes through here — and one that does not fails the
 * test quickly, with a message that says so.
 */
async function settles<T>(promise: Promise<T>, ms = 1000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`the promise did not settle within ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** The message a rejection carries, and nothing else. */
function messageOf(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The rejection's message, asserted to be exactly this one.
 *
 * "Exactly" is the point: Bun's `toThrow("text")` matches a substring, so a message
 * that merely carries the failure's message inside it would pass, and the law would
 * not be checked at all.
 */
async function rejectsWith(promise: Promise<unknown>, message: string): Promise<string> {
	const reason = await settles(promise).then(
		() => {
			throw new Error("the call resolved instead of rejecting");
		},
		(failure: unknown) => failure,
	);
	const actual = messageOf(reason);
	expect(actual).toBe(message);
	return actual;
}

describe("the capability bridge", () => {
	test("a registered capability is reachable and its value comes back", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, { capabilities: { double: (args) => (args as { n: number }).n * 2 } });

		const client = createCapabilityClient(up);
		expect(await settles(client.call("double", { n: 21 }))).toBe(42);
	});

	test("an unknown capability is refused by name", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, { capabilities: { double: (args) => (args as { n: number }).n * 2 } });

		const client = createCapabilityClient(up);
		await rejectsWith(client.call("triple", { n: 1 }), 'unknown capability "triple"');
	});

	test("a name on the prototype chain is not a capability the host registered", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, { capabilities: { double: (args) => (args as { n: number }).n * 2 } });

		const client = createCapabilityClient(up);
		await rejectsWith(client.call("toString"), 'unknown capability "toString"');
		await rejectsWith(client.call("constructor"), 'unknown capability "constructor"');
	});

	test("a capability that fails rejects with the failure's own message", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, {
			capabilities: {
				explode: () => {
					throw new Error("the disk is on fire");
				},
			},
		});

		const client = createCapabilityClient(up);
		await rejectsWith(client.call("explode"), "the disk is on fire");
	});

	test("a capability that rejects rejects with the failure's own message", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, {
			capabilities: {
				explode: async () => {
					throw new Error("the network is down");
				},
			},
		});

		const client = createCapabilityClient(up);
		await rejectsWith(client.call("explode"), "the network is down");
	});

	test("a capability that fails with a value that is not an error rejects with that value's message", async () => {
		const { up, down } = pair();
		const failure = "the disk is on fire";
		createCapabilityHost(down, {
			capabilities: {
				explode: () => {
					throw failure;
				},
			},
		});

		const client = createCapabilityClient(up);
		await rejectsWith(client.call("explode"), "the disk is on fire");
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
		const [first, second] = await settles(
			Promise.all([
				client.call("slow", { n: 1, wait: 30 }),
				client.call("slow", { n: 2, wait: 1 }),
			]),
		);
		expect(first).toBe(1);
		expect(second).toBe(2);
	});

	test("a result the channel cannot carry fails the call instead of hanging it", async () => {
		const { up, down } = strictPair();
		createCapabilityHost(down, {
			capabilities: { uncarryable: () => () => {} },
		});

		const client = createCapabilityClient(up);
		await rejectsWith(client.call("uncarryable"), "the result cannot be sent");
	});

	test("an argument the channel cannot carry rejects the call", async () => {
		const { up, down } = strictPair();
		createCapabilityHost(down, { capabilities: { anything: () => 1 } });

		const client = createCapabilityClient(up);
		await rejectsWith(client.call("anything", () => {}), "the arguments cannot be sent");
	});

	test("a capability failure and a carrying failure stay distinguishable", async () => {
		const { up, down } = strictPair();
		createCapabilityHost(down, {
			capabilities: {
				explode: () => {
					throw new Error("the disk is on fire");
				},
				uncarryable: () => () => {},
			},
		});

		const client = createCapabilityClient(up);
		const failed = await rejectsWith(client.call("explode"), "the disk is on fire");
		const carrying = await rejectsWith(client.call("uncarryable"), "the result cannot be sent");
		expect(failed).not.toBe(carrying);
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
		await settles(client.call("fine"));
		await settles(client.call("explode").catch(() => undefined));
		await settles(client.call("nowhere").catch(() => undefined));

		expect(answered).toHaveLength(3);
	});

	test("an answer no call is waiting for is discarded", async () => {
		const { up, down } = pair();
		createCapabilityHost(down, {
			capabilities: {
				answer: async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return 42;
				},
			},
		});

		const client = createCapabilityClient(up);
		let settled: unknown = "nothing yet";
		const call = client.call("answer").then((value) => {
			settled = value;
			return value;
		});

		// An answer nobody asked for: it must not be handed to the caller that is.
		down.post({ kind: "answer", id: "nobody", ok: true, value: "stray" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(settled).toBe("nothing yet");

		expect(await settles(call)).toBe(42);
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
