import { describe, expect, test } from "bun:test";
import { createWorkerHost } from "../src/worker/host.ts";
import type { WorkerHost, WorkerLike } from "../src/worker/host.ts";
import type { AgentEvent } from "../src/core/events.ts";
import type { AnswerFrame, CallFrame } from "../src/worker/protocol.ts";

/**
 * The worker host: the module that owns the realm the agent runs in.
 *
 * The host is the application's side of the worker boundary, and it has four jobs.
 * Each of them is a law, and each of them is pinned here:
 *
 * - it exposes the capabilities the worker may call — through the bridge — and only
 *   those;
 * - it forwards the worker's events to the application, in the order they were
 *   sent, so that the interface can render them;
 * - it can end the realm, and afterwards it answers nothing;
 * - it never raises: a broken worker must not break the application.
 *
 * The wire format is the one the core already speaks. An event travels as
 * `{ kind: "event", event }` — the frame the run's own outputs are — and a capability
 * call travels as `{ kind: "call", id, capability, args }`. Anything else on the
 * channel is the application's own traffic and reaches `onOtherFrame`.
 *
 * There is no real `Worker` here: the laws are about the host, and the worker is
 * something the test fakes. The fake can also be told to refuse the messages
 * posted to it, because "the host never raises" needs a worker that fails.
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

	test("terminate ends the realm", () => {
		const fake = makeFakeWorker();
		const host: WorkerHost = createWorkerHost(fake, { capabilities: { fine: () => 1 } });

		host.terminate();

		expect(fake.terminations).toBe(1);
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
