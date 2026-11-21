import { describe, expect, test } from "bun:test";
import { delegate, type DelegateOptions } from "../src/exchange/delegate.ts";
import type { ExchangeFrame } from "../src/exchange/protocol.ts";
import type { AgentEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
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

const readFile: ToolDefinition = {
	name: "read_file",
	description: "reads a file",
	parameters: {
		kind: "object",
		properties: { path: { kind: "string" } },
		required: ["path"],
		additional: false,
	},
	execute: async (call) => {
		const args = JSON.parse(call.argumentsText) as { path: string };
		return { content: [{ type: "text", text: `contents of ${args.path}` }] };
	},
};

function options(overrides: Partial<DelegateOptions> = {}): DelegateOptions {
	const base: DelegateOptions = {
		port: pair().down,
		taskId: "t1",
		task: "read a.txt",
		context: "from the browser",
		tools: toolRegistry([readFile]),
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
	test("the offer is sent once, with the task, the context and the tools the peer may call", () => {
		const channels = pair();
		delegate({ ...options(), port: channels.down });

		const offers = channels.sent.filter((frame) => frame.kind === "offer");
		expect(offers).toHaveLength(1);
		const offer = offers[0];
		if (offer?.kind !== "offer") throw new Error("no offer");
		expect(offer.task).toBe("read a.txt");
		expect(offer.context).toBe("from the browser");
		expect(offer.tools).toEqual(["read_file"]);
	});

	test("the peer's events reach the delegator in order", async () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		channels.up.post({ kind: "event", taskId: "t1", event: agentEvent("message_start") });
		channels.up.post({ kind: "event", taskId: "t1", event: agentEvent("message_end") });
		// The peer finishes the task; the delegated stream ends with it.
		channels.up.post({ kind: "result", taskId: "t1", outcome: { kind: "completed" } });

		const seen: string[] = [];
		for await (const event of task.events) seen.push(event.type);

		expect(seen).toEqual(["message_start", "message_end"]);
	});

	test("a call the peer makes runs the local tool and the answer comes back", async () => {
		const channels = pair();
		delegate({ ...options(), port: channels.down });

		channels.up.post({
			kind: "call",
			taskId: "t1",
			callId: "c1",
			tool: "read_file",
			args: { path: "a.txt" },
		});
		await settles(new Promise((resolve) => setTimeout(resolve, 10)));

		const answers = channels.sent.filter((frame) => frame.kind === "answer");
		expect(answers).toHaveLength(1);
		const answer = answers[0];
		if (answer?.kind !== "answer") throw new Error("no answer");
		expect(answer.callId).toBe("c1");
		expect(answer.ok).toBe(true);
		expect(answer.result?.content[0]).toEqual({ type: "text", text: "contents of a.txt" });
	});

	test("a call to a tool the host does not have is answered with a failure", async () => {
		const channels = pair();
		delegate({ ...options(), port: channels.down });

		channels.up.post({
			kind: "call",
			taskId: "t1",
			callId: "c1",
			tool: "nosuch",
			args: {},
		});
		await settles(new Promise((resolve) => setTimeout(resolve, 10)));

		const answers = channels.sent.filter((frame) => frame.kind === "answer");
		expect(answers).toHaveLength(1);
		const answer = answers[0];
		if (answer?.kind !== "answer") throw new Error("no answer");
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("nosuch");
	});

	test("a call with arguments the tool's dialect rejects is answered with a failure", async () => {
		const channels = pair();
		delegate({ ...options(), port: channels.down });

		channels.up.post({
			kind: "call",
			taskId: "t1",
			callId: "c1",
			tool: "read_file",
			args: { path: 7 },
		});
		await settles(new Promise((resolve) => setTimeout(resolve, 10)));

		const answers = channels.sent.filter((frame) => frame.kind === "answer");
		const answer = answers[0];
		if (answer?.kind !== "answer") throw new Error("no answer");
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("/path");
	});

	test("the host's permission hook applies to a call the peer makes", async () => {
		const channels = pair();
		delegate({
			...options(),
			port: channels.down,
			beforeToolCall: () => ({ block: true, reason: "the user refused" }),
		});

		channels.up.post({
			kind: "call",
			taskId: "t1",
			callId: "c1",
			tool: "read_file",
			args: { path: "a.txt" },
		});
		await settles(new Promise((resolve) => setTimeout(resolve, 10)));

		const answers = channels.sent.filter((frame) => frame.kind === "answer");
		const answer = answers[0];
		if (answer?.kind !== "answer") throw new Error("no answer");
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("the user refused");
	});

	test("the task resolves with the peer's outcome", async () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		channels.up.post({ kind: "result", taskId: "t1", outcome: { kind: "completed" } });

		expect(await settles(task.outcome)).toEqual({ kind: "completed" });
	});

	test("a refusal resolves as a failure carrying the reason", async () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		channels.up.post({ kind: "refuse", taskId: "t1", reason: "the backend is busy" });

		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(outcome.kind === "failed" ? outcome.error : undefined).toBe("the backend is busy");
	});

	test("the peer's outcome is taken verbatim", async () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		channels.up.post({
			kind: "result",
			taskId: "t1",
			outcome: { kind: "failed", error: "the peer's own failure" },
		});

		const outcome = await settles(task.outcome);
		expect(outcome).toEqual({ kind: "failed", error: "the peer's own failure" });
	});

	test("a tool that throws is answered with a failure, not a crash", async () => {
		const channels = pair();
		const boom: ToolDefinition = {
			name: "boom",
			description: "fails",
			parameters: { kind: "object", properties: {} },
			execute: async () => {
				throw new Error("the tool is on fire");
			},
		};
		delegate({ ...options(), port: channels.down, tools: toolRegistry([boom]) });

		channels.up.post({ kind: "call", taskId: "t1", callId: "c1", tool: "boom", args: {} });
		await settles(new Promise((resolve) => setTimeout(resolve, 10)));

		const answers = channels.sent.filter((frame) => frame.kind === "answer");
		expect(answers).toHaveLength(1);
		const answer = answers[0];
		if (answer?.kind !== "answer") throw new Error("no answer");
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("the tool is on fire");
	});

	test("every event the peer sends is forwarded, the last one included", async () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		channels.up.post({ kind: "event", taskId: "t1", event: agentEvent("message_start") });
		channels.up.post({ kind: "event", taskId: "t1", event: agentEvent("agent_end") });
		channels.up.post({ kind: "result", taskId: "t1", outcome: { kind: "completed" } });

		const seen: string[] = [];
		for await (const event of task.events) seen.push(event.type);
		expect(seen).toEqual(["message_start", "agent_end"]);
	});

	test("two calls are answered with their own ids", async () => {
		const channels = pair();
		delegate({ ...options(), port: channels.down });

		channels.up.post({
			kind: "call",
			taskId: "t1",
			callId: "c1",
			tool: "read_file",
			args: { path: "a.txt" },
		});
		channels.up.post({
			kind: "call",
			taskId: "t1",
			callId: "c2",
			tool: "read_file",
			args: { path: "b.txt" },
		});
		await settles(new Promise((resolve) => setTimeout(resolve, 10)));

		const answers = channels.sent.filter((frame) => frame.kind === "answer");
		expect(answers.map((answer) => (answer.kind === "answer" ? answer.callId : ""))).toEqual([
			"c1",
			"c2",
		]);
	});

	test("cancelling tells the peer", () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		task.cancel();

		const cancels = channels.sent.filter((frame) => frame.kind === "cancel");
		expect(cancels).toHaveLength(1);
	});

	test("a frame for another task is not ours", async () => {
		const channels = pair();
		const task = delegate({ ...options(), port: channels.down });

		channels.up.post({ kind: "event", taskId: "other", event: agentEvent("message_start") });
		channels.up.post({ kind: "result", taskId: "t1", outcome: { kind: "completed" } });

		const seen: string[] = [];
		for await (const event of task.events) seen.push(event.type);
		expect(seen).toEqual([]);
	});
});
