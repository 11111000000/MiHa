/**
 * The in-memory peer link.
 *
 * The example's peer port is the one thing in it that has behaviour of its own:
 * the frames it carries, and the moment it carries them. Both are pinned here, so
 * that the exchange above it is tested against a known transport.
 *
 * The test is hermetic and fast: two objects and a microtask.
 */

import { describe, expect, test } from "bun:test";
import { isExchangeFrame } from "../../src/exchange/index.ts";
import { createPortPair } from "./peer.ts";

/** Lets the queued deliveries happen. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the in-memory peer link", () => {
	test("a frame posted on one end arrives at the other", async () => {
		const ports = createPortPair();
		const received: unknown[] = [];
		ports.there.onMessage((message) => {
			received.push(message);
		});

		ports.here.post({ kind: "offer", version: 1, taskId: "t1", task: "hello" });
		await settle();

		expect(received).toHaveLength(1);
		expect(received[0]).toEqual({ kind: "offer", version: 1, taskId: "t1", task: "hello" });
		expect(isExchangeFrame(received[0])).toBe(true);
	});

	test("the frames travel the other way too", async () => {
		const ports = createPortPair();
		const received: unknown[] = [];
		ports.here.onMessage((message) => {
			received.push(message);
		});

		ports.there.post({ kind: "accept", taskId: "t1" });
		await settle();

		expect(received).toEqual([{ kind: "accept", taskId: "t1" }]);
	});

	test("a frame is delivered in the next turn, not in place", async () => {
		const ports = createPortPair();
		const received: unknown[] = [];
		ports.there.onMessage((message) => {
			received.push(message);
		});

		ports.here.post({ kind: "accept", taskId: "t1" });
		// A port that delivered in place would let a frame arrive before the side
		// that should receive it was listening — and the exchange would lose a task.
		expect(received).toEqual([]);

		await settle();
		expect(received).toHaveLength(1);
	});

	test("a listener that arrives after the post still hears the frame", async () => {
		const ports = createPortPair();

		ports.here.post({ kind: "accept", taskId: "t1" });
		const received: unknown[] = [];
		ports.there.onMessage((message) => {
			received.push(message);
		});

		await settle();
		expect(received).toEqual([{ kind: "accept", taskId: "t1" }]);
	});

	test("every listener of an end hears the frame", async () => {
		const ports = createPortPair();
		const first: unknown[] = [];
		const second: unknown[] = [];
		ports.there.onMessage((message) => {
			first.push(message);
		});
		ports.there.onMessage((message) => {
			second.push(message);
		});

		ports.here.post({ kind: "cancel", taskId: "t1" });
		await settle();

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
	});
});
