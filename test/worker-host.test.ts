import { describe, expect, test } from "bun:test";
import { createWorkerHost } from "../src/worker/host.ts";
import type { WorkerHost, WorkerLike } from "../src/worker/host.ts";
import type { AgentEvent, PartialAssistantMessage } from "../src/core/events.ts";
import type {
	AssistantMessage,
	TextContent,
	ToolResult,
	ToolResultMessage,
	Usage,
} from "../src/core/messages.ts";
import type { AnswerFrame, CallFrame, CapabilityFn } from "../src/worker/protocol.ts";

/**
 * The worker host: the module that owns the realm the agent runs in.
 *
 * The host is the application's side of the worker boundary, and it has four jobs.
 * Each of them is a law, and each of them is pinned here:
 *
 * - it exposes the capabilities the worker may call — through the bridge — and only
 *   those;
 * - it forwards the worker's events to the application, in the order they were
 *   sent, whole and every one of them, so that the interface can render them;
 * - it can end the realm, and afterwards it answers nothing — not even a call that
 *   was in flight when the realm ended;
 * - it never raises: a broken worker must not break the application.
 *
 * The wire format is the one the core already speaks. An event travels as
 * `{ kind: "event", event }` — the frame the run's own outputs are — and a capability
 * call travels as `{ kind: "call", id, capability, args }`. Anything else on the
 * channel is the application's own traffic and reaches `onOtherFrame`.
 *
 * There is no real `Worker` here: the laws are about the host, and the worker is
 * something the test fakes. The fake can also be told to refuse the messages
 * posted to it, and to refuse to end, because "the host never raises" needs a
 * worker that fails.
 */

/** The frame the worker posts to carry an event to the application. */
interface EventFrame {
	readonly kind: "event";
	readonly event: AgentEvent;
}

/**
 * A worker that records what was posted to it and lets the test push messages in.
 *
 * A message delivered before the host has begun to listen is queued and delivered
 * when the listener arrives: a worker that boots before the host is listening must
 * not lose its first capability call.
 */
interface FakeWorker extends WorkerLike {
	/** Everything the host posted to the worker, in the order it was posted. */
	readonly posted: readonly unknown[];
	/** How many times the host terminated the worker. */
	readonly terminations: number;
	/** While set, every message posted to the worker is refused and throws. */
	broken: boolean;
	/** While set, the worker's own end throws: it cannot be terminated. */
	terminateBroken: boolean;
	/** Pushes a message to the host, as a worker would. */
	deliver(data: unknown): void;
	/** Resolves with the first posted message the predicate accepts. */
	postedMatching(predicate: (message: unknown) => boolean): Promise<unknown>;
}

function makeFakeWorker(): FakeWorker {
	const posted: unknown[] = [];
	const waiters: ((message: unknown) => void)[] = [];
	const queue: unknown[] = [];
	let terminated = 0;
	let onmessage: ((event: { data: unknown }) => void) | null = null;

	const fake: FakeWorker = {
		posted,
		broken: false,
		terminateBroken: false,
		get terminations() {
			return terminated;
		},
		get onmessage() {
			return onmessage;
		},
		set onmessage(handler: ((event: { data: unknown }) => void) | null) {
			onmessage = handler;
			if (!handler) return;
			while (queue.length > 0) {
				const data = queue.shift();
				if (data !== undefined) handler({ data });
			}
		},
		postMessage(message: unknown) {
			if (fake.broken) throw new Error("the worker refuses the message");
			posted.push(message);
			for (const waiter of waiters) waiter(message);
		},
		terminate() {
			terminated += 1;
			if (fake.terminateBroken) throw new Error("the worker cannot be terminated");
		},
		deliver(data: unknown) {
			if (!onmessage) {
				queue.push(data);
				return;
			}
			onmessage({ data });
		},
		postedMatching(predicate: (message: unknown) => boolean): Promise<unknown> {
			const existing = posted.find((message) => predicate(message));
			if (existing !== undefined) return Promise.resolve(existing);
			return new Promise((resolve) => {
				waiters.push((message) => {
					if (predicate(message)) resolve(message);
				});
			});
		},
	};

	return fake;
}

/** The frame a worker posts to ask the host for a capability. */
function call(id: string, capability: string, args: unknown = null): CallFrame {
	return { kind: "call", id, capability, args };
}

/** The frame a worker posts to carry an event to the application. */
function eventFrame(event: AgentEvent): EventFrame {
	return { kind: "event", event };
}

/**
 * One event of every variant the core defines.
 *
 * The host does not know the vocabulary — that belongs to the core — so it must
 * forward every variant it is handed. A list that names them all is what makes
 * "every variant" a thing that can be checked instead of a thing that is hoped for.
 */
function everyEvent(): readonly AgentEvent[] {
	const content: TextContent = { type: "text", text: "hello" };
	const usage: Usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
	const assistant: AssistantMessage = { role: "assistant", content: [content], usage, stopReason: "stop" };
	const toolResult: ToolResult = { content: [content], isError: false };
	const partial: PartialAssistantMessage = { role: "assistant", content: [content] };
	const toolResults: readonly ToolResultMessage[] = [
		{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [content], isError: false },
	];
	return [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_start", id: "m1", role: "assistant" },
		{
			type: "message_update",
			id: "m1",
			message: partial,
			providerEvent: { type: "text_delta", delta: "he" },
		},
		{ type: "message_end", id: "m1", message: assistant },
		{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.txt" } },
		{
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "a.txt" },
			partialResult: toolResult,
		},
		{ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: toolResult, isError: false },
		{ type: "turn_end", message: assistant, toolResults },
		{ type: "agent_end", messages: [assistant], outcome: { kind: "completed" } },
	];
}

/** The answer frames among the messages a host posted, in the order they were posted. */
function answersIn(messages: readonly unknown[]): readonly AnswerFrame[] {
	return messages.filter(isAnswer);
}

/** Whether the frame is an answer — the bridge's own frame, and the host's too. */
function isAnswer(message: unknown): message is AnswerFrame {
	return typeof message === "object" && message !== null && "kind" in message && message.kind === "answer";
}

/** The number the arguments carry, or a failure that says they carry none. */
function numberIn(args: unknown): number {
	if (typeof args === "object" && args !== null && "n" in args && typeof args.n === "number") return args.n;
	throw new Error("the arguments carry no number");
}

/**
 * A promise and the hand that settles it.
 *
 * The hand is what makes a test exact: a timer has to be long enough not to be
 * flaky and short enough to be quick, and those two pull against each other.
 */
function deferred<T>(): { readonly promise: Promise<T>; release: (value: T) => void } {
	let release!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/**
 * A promise that is supposed to settle, raced against a short timer.
 *
 * Bun's per-test timeout does fire on a bare promise that never settles — but not
 * on `expect(promise).rejects.toThrow(...)`, which waits forever, and a hung gate
 * is worse than a failing one. So every promise that must settle goes through here,
 * and one that does not fails the test in a second, with a message that says so.
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

/**
 * Waits a moment, so that the host has had every chance to answer — or to stay
 * silent. A silence is proved by waiting, not by looking.
 */
async function pause(ms = 0): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The answer the host posted for the call with that id.
 *
 * The wait is raced against a timer, so a host that never answers fails the test
 * quickly instead of hanging the run.
 */
async function answerFor(fake: FakeWorker, id: string): Promise<AnswerFrame> {
	const posted = await settles(fake.postedMatching((message) => isAnswer(message) && message.id === id));
	if (!isAnswer(posted)) throw new Error(`the host posted no answer for "${id}"`);
	return posted;
}

describe("the worker host", () => {
	test("the worker's events reach the application in the order they were sent", async () => {
		const fake = makeFakeWorker();
		const events: AgentEvent[] = [];
		createWorkerHost(fake, { capabilities: {}, onEvent: (event) => events.push(event) });

		fake.deliver(eventFrame({ type: "agent_start" }));
		fake.deliver(eventFrame({ type: "turn_start" }));
		fake.deliver(eventFrame({ type: "agent_end", messages: [], outcome: { kind: "completed" } }));

		await pause();
		expect(events.map((event) => event.type)).toEqual(["agent_start", "turn_start", "agent_end"]);
	});

	test("every event the worker sends reaches the application, whole and in order", async () => {
		const fake = makeFakeWorker();
		const events: AgentEvent[] = [];
		createWorkerHost(fake, { capabilities: {}, onEvent: (event) => events.push(event) });

		const sent = everyEvent();
		for (const event of sent) fake.deliver(eventFrame(event));

		await pause();
		// The host may not pick and choose: a variant it dislikes would leave a hole
		// in the transcript the interface is drawing.
		expect(events).toHaveLength(sent.length);
		expect(events).toEqual([...sent]);
	});

	test("the application receives the event the worker sent, not a summary of it", async () => {
		const fake = makeFakeWorker();
		const events: AgentEvent[] = [];
		createWorkerHost(fake, { capabilities: {}, onEvent: (event) => events.push(event) });

		const sent: AgentEvent = {
			type: "message_update",
			id: "m1",
			message: { role: "assistant", content: [{ type: "text", text: "hel" }] },
			providerEvent: { type: "text_delta", delta: "hel" },
		};
		fake.deliver(eventFrame(sent));
		await pause();

		expect(events).toHaveLength(1);
		// The event itself, with its payload: a type on its own says nothing about
		// what the interface has to draw.
		expect(events[0]).toBe(sent);
		expect(events[0]).toEqual(sent);
	});

	test("an event of a type the host has never seen is forwarded all the same", async () => {
		const fake = makeFakeWorker();
		const events: unknown[] = [];
		createWorkerHost(fake, { capabilities: {}, onEvent: (event) => events.push(event) });

		// The vocabulary of the events belongs to the core, and the core may grow a
		// variant the host has never heard of. The host forwards what the frame
		// carries; it does not judge it.
		const sent: unknown = { type: "a_variant_the_core_has_not_written_yet", detail: "kept" };
		fake.deliver({ kind: "event", event: sent });
		await pause();

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(sent);
	});

	test("a capability the host registered is reachable and its value comes back", async () => {
		const fake = makeFakeWorker();
		createWorkerHost(fake, { capabilities: { double: (args) => numberIn(args) * 2 } });

		fake.deliver(call("c1", "double", { n: 21 }));

		const answer = await answerFor(fake, "c1");
		expect(answer.ok).toBe(true);
		expect(answer.value).toBe(42);
	});

	test("a capability the host did not register is refused by name", async () => {
		const fake = makeFakeWorker();
		createWorkerHost(fake, { capabilities: { double: (args) => numberIn(args) * 2 } });

		fake.deliver(call("c1", "triple", { n: 1 }));

		const answer = await answerFor(fake, "c1");
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("triple");
	});

	test("the worker reaches the application's own capabilities and nothing else", async () => {
		const fake = makeFakeWorker();
		let enumerated = false;
		const target: Record<string, CapabilityFn> = { alpha: () => 1, beta: () => 2 };
		const table = new Proxy(target, {
			ownKeys(own) {
				enumerated = true;
				return Reflect.ownKeys(own);
			},
		});
		createWorkerHost(fake, { capabilities: table });

		fake.deliver(call("c1", "alpha"));
		fake.deliver(call("c2", "beta"));
		// A name the application never registered, and a name the language puts on
		// every object: neither of them is a capability.
		fake.deliver(call("c3", "ping"));
		fake.deliver(call("c4", "toString"));

		expect((await answerFor(fake, "c1")).value).toBe(1);
		expect((await answerFor(fake, "c2")).value).toBe(2);
		expect((await answerFor(fake, "c3")).ok).toBe(false);
		expect((await answerFor(fake, "c4")).ok).toBe(false);
		// The host neither copied the table nor extended it: either would have
		// enumerated it, and a table the host owns is a table the host may grow.
		expect(enumerated).toBe(false);
	});

	test("terminate ends the realm", () => {
		const fake = makeFakeWorker();
		const host: WorkerHost = createWorkerHost(fake, { capabilities: { fine: () => 1 } });

		host.terminate();

		expect(fake.terminations).toBe(1);
	});

	test("terminate does not raise out of a worker that cannot be terminated", () => {
		const fake = makeFakeWorker();
		const host = createWorkerHost(fake, { capabilities: { fine: () => 1 } });
		fake.terminateBroken = true;

		expect(() => host.terminate()).not.toThrow();

		// And the realm is over all the same: the host does not keep talking to a
		// worker it could not end.
		host.channel.post({ kind: "prompt", text: "hello" });
		expect(fake.posted).toEqual([]);
	});

	test("the host answers nothing after the realm ended", async () => {
		const fake = makeFakeWorker();
		const host = createWorkerHost(fake, { capabilities: { fine: () => 1 } });

		fake.deliver(call("c1", "fine"));
		expect((await answerFor(fake, "c1")).ok).toBe(true);

		host.terminate();

		// A call that arrives after the realm ended must go unanswered: there is
		// nobody left to answer it.
		fake.deliver(call("c2", "fine"));
		await pause(20);

		expect(answersIn(fake.posted).map((answer) => answer.id)).toEqual(["c1"]);
	});

	test("a call that resolves after the realm ended is not answered", async () => {
		const fake = makeFakeWorker();
		const pending = deferred<number>();
		const host = createWorkerHost(fake, { capabilities: { slow: () => pending.promise } });

		fake.deliver(call("c1", "slow"));
		await pause();

		host.terminate();
		pending.release(42);
		await pause(20);

		// The answer was owed to a realm that no longer exists: a call in flight
		// when the end came is a call nobody will ever read the answer to.
		expect(answersIn(fake.posted)).toEqual([]);
	});

	test("a worker whose postMessage throws does not break the application", async () => {
		const fake = makeFakeWorker();
		const raised: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			raised.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			createWorkerHost(fake, { capabilities: { fine: () => 1 } });

			// The worker refuses every message the host posts to it.
			fake.broken = true;
			expect(() => fake.deliver(call("c1", "fine"))).not.toThrow();
			await pause(20);

			// Nothing came out of the host: the failure was swallowed.
			expect(raised).toEqual([]);

			// And the host is still usable: the worker still gets its answer.
			fake.broken = false;
			fake.deliver(call("c2", "fine"));
			const answer = await answerFor(fake, "c2");
			expect(answer.ok).toBe(true);
			expect(raised).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("the application's own post to a worker that refuses it does not raise", () => {
		const fake = makeFakeWorker();
		const host = createWorkerHost(fake, { capabilities: {} });

		// The host's own path to the worker, not the bridge's: the application
		// posting, and the worker refusing.
		fake.broken = true;
		expect(() => host.channel.post({ kind: "prompt", text: "hello" })).not.toThrow();

		// And the host is still usable: the next message goes through.
		fake.broken = false;
		host.channel.post({ kind: "prompt", text: "again" });
		expect(fake.posted).toContainEqual({ kind: "prompt", text: "again" });
	});

	test("a frame the host does not own reaches the application", async () => {
		const fake = makeFakeWorker();
		const others: unknown[] = [];
		createWorkerHost(fake, { capabilities: {}, onOtherFrame: (frame) => others.push(frame) });

		fake.deliver({ kind: "note", text: "not an event" });
		await pause();

		expect(others).toEqual([{ kind: "note", text: "not an event" }]);
	});

	test("the application posts to the worker through the host's channel", async () => {
		const fake = makeFakeWorker();
		const host = createWorkerHost(fake, { capabilities: {} });

		host.channel.post({ kind: "prompt", text: "hello" });

		expect(fake.posted).toContainEqual({ kind: "prompt", text: "hello" });
	});
});
