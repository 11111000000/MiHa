import { describe, expect, test } from "bun:test";
import { delegate, type DelegateOptions } from "../src/exchange/delegate.ts";
import type { ExchangeFrame } from "../src/exchange/protocol.ts";
import type { AgentEvent } from "../src/core/events.ts";
import { assistantMessage } from "../src/core/messages.ts";

/**
 * A channel with a queue, so a frame posted before the listener arrives is not lost.
 */
function makeChannel(): { post: (message: unknown) => void; onMessage: (handler: (message: unknown) => void) => void } {
	const handlers: ((message: unknown) => void)[] = [];
	const queue: unknown[] = [];
	return {
		post(message: unknown) {
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

function pair(): {
	up: { post: (m: unknown) => void; onMessage: (h: (m: unknown) => void) => void };
	down: { post: (m: unknown) => void; onMessage: (h: (m: unknown) => void) => void };
	sent: ExchangeFrame[];
} {
	const toWorker = makeChannel();
	const toHost = makeChannel();
	const sent: ExchangeFrame[] = [];
	return {
		up: {
			post: (message) => toHost.post(message),
			onMessage: (handler) => toWorker.onMessage(handler),
		},
		down: {
			post: (message) => {
				sent.push(message as ExchangeFrame);
				toWorker.post(message);
			},
			onMessage: (handler) => toHost.onMessage(handler),
		},
		sent,
	};
}

async function settles<T>(promise: Promise<T>, ms = 1000): Promise<T> {
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

function options(overrides: Partial<DelegateOptions> = {}): DelegateOptions {
	const base: DelegateOptions = {
		port: pair().down,
		taskId: "t1",
		task: "read a.txt",
		context: "from the browser",
	};
	return { ...base, ...overrides };
}

function agentEvent(
	type: "agent_start" | "turn_start" | "message_start" | "message_end" | "agent_end",
): AgentEvent {
	switch (type) {
		case "agent_start":
			return { type: "agent_start" };
		case "turn_start":
			return { type: "turn_start" };
		case "message_start":
			return { type: "message_start", id: "m1", role: "assistant" };
		case "message_end":
			return { type: "message_end", id: "m1", message: assistantMessage([], "stop") };
		case "agent_end":
			return { type: "agent_end", messages: [], outcome: { kind: "completed" } };
	}
}

describe("the delegating side of the exchange", () => {
	test("the offer carries the task and the context, and nothing about our tools", () => {
		const channels = pair();
		delegate({ ...options(), port: channels.down });

		const offers = channels.sent.filter((frame) => frame.kind === "offer");
		expect(offers).toHaveLength(1);
		const offer = offers[0];
		if (offer?.kind !== "offer") throw new Error("no offer");
		expect(offer.version).toBe(1);
		expect(offer.task).toBe("read a.txt");
		expect(offer.context).toBe("from the browser");
		expect("tools" in offer).toBe(false);
	});

	test("the offer is sent once", () => {
		const channels = pair();
		delegate({ ...options(), port: channels.down });
		expect(channels.sent.filter((frame) => frame.kind === "offer")).toHaveLength(1);
	});

	test("a peer cannot reach our tools: a call frame is not ours and is ignored", async () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		channels.up.post({
			kind: "call",
			taskId: "t1",
			callId: "c1",
			tool: "read_file",
			args: { path: "a.txt" },
		} as unknown as ExchangeFrame);
		channels.up.post({ kind: "result", taskId: "t1", outcome: { kind: "completed" } });

		const seen: string[] = [];
		for await (const event of task.events) seen.push(event.type);

		// Nothing was answered, and nothing was forwarded.
		expect(seen).toEqual([]);
		expect(channels.sent.filter((frame) => frame.kind === "result")).toHaveLength(0);
		expect(channels.sent.filter((frame) => frame.kind === "event")).toHaveLength(0);
	});

	test("the peer's outcome is taken verbatim", async () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		channels.up.post({
			kind: "result",
			taskId: "t1",
			outcome: { kind: "failed", error: "the peer's own failure" },
		});

		expect(await settles(task.outcome)).toEqual({ kind: "failed", error: "the peer's own failure" });
	});

	test("a refusal resolves as a failure carrying the reason", async () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		channels.up.post({ kind: "refuse", taskId: "t1", reason: "the backend is busy" });

		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(outcome.kind === "failed" ? outcome.error : undefined).toBe("the backend is busy");
	});

	test("every event the peer sends is forwarded, the last one included", async () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		channels.up.post({ kind: "event", taskId: "t1", event: agentEvent("message_start") });
		channels.up.post({ kind: "event", taskId: "task-other", event: agentEvent("turn_start") });
		channels.up.post({ kind: "event", taskId: "t1", event: agentEvent("agent_end") });
		channels.up.post({ kind: "result", taskId: "t1", outcome: { kind: "completed" } });

		const seen: string[] = [];
		for await (const event of task.events) seen.push(event.type);
		expect(seen).toEqual(["message_start", "agent_end"]);
	});

	test("cancelling tells the peer", () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		task.cancel();

		expect(channels.sent.filter((frame) => frame.kind === "cancel")).toHaveLength(1);
	});
});
