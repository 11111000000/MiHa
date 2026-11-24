import { describe, expect, test } from "bun:test";
import { receive, type TaskDecision } from "../src/exchange/receive.ts";
import { protocolVersion, type ExchangeFrame, type ExchangePort, type OfferFrame } from "../src/exchange/protocol.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import type { ProviderEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import type { JournalEntry } from "../src/core/journal.ts";

/**
 * A port with a queue, so a frame posted before the listener arrives is not lost.
 *
 * The observer sees every frame **as it is posted**, which is what lets a test ask
 * what the peer knew at the moment it was told something.
 *
 * `breaks` is the broken transport: when it answers true, the frame does not go —
 * the transport throws, and the peer hears nothing.
 */
function fakePort(
	observe?: (frame: ExchangeFrame) => void,
	breaks?: (frame: ExchangeFrame) => boolean,
): {
	readonly port: ExchangePort;
	/** The frames the receiving side sent to the peer. */
	readonly sent: ExchangeFrame[];
	fromPeer(message: unknown): void;
} {
	const handlers: ((message: unknown) => void)[] = [];
	const queue: unknown[] = [];
	const sent: ExchangeFrame[] = [];
	return {
		port: {
			post(message: unknown) {
				const frame = message as ExchangeFrame;
				if (breaks?.(frame)) throw new Error("the socket is closed");
				sent.push(frame);
				observe?.(frame);
			},
			onMessage(handler: (message: unknown) => void) {
				handlers.push(handler);
				while (queue.length > 0) handler(queue.shift());
			},
		},
		sent,
		fromPeer(message: unknown) {
			if (handlers.length === 0) {
				queue.push(message);
				return;
			}
			for (const handler of handlers) handler(message);
		},
	};
}

/** The entries the receiving side sent as `event` frames. */
function sentEntries(frames: readonly ExchangeFrame[]): JournalEntry[] {
	return frames.flatMap((frame) => (frame.kind === "event" ? [frame.event] : []));
}

/** The outcome the receiving side sent in its `result` frame. */
function sentOutcome(frames: readonly ExchangeFrame[]): unknown {
	const results = frames.filter((frame) => frame.kind === "result");
	const last = results[results.length - 1];
	return last?.kind === "result" ? last.outcome : undefined;
}

function offer(overrides: Partial<OfferFrame> = {}): OfferFrame {
	return { kind: "offer", version: protocolVersion, taskId: "t1", task: "read a.txt", ...overrides };
}

/**
 * A provider that replays a script.
 *
 * The same shape a real adapter has, which is the point: the core cannot tell the
 * difference.
 */
function scriptedProvider(script: readonly (readonly ProviderEvent[])[]): HarnessHost["callProvider"] {
	let turn = 0;
	return async function* callProvider(_request: ProviderRequest) {
		const events = script[turn] ?? [];
		turn += 1;
		for (const event of events) yield event;
	};
}

const readFile: ToolDefinition = {
	name: "read_file",
	description: "reads a file",
	parameters: {
		kind: "object",
		properties: { path: { kind: "string" } },
		required: ["path"],
	},
	execute: async (_call, args) => ({
		content: [{ type: "text", text: `contents of ${String(args.path)}` }],
	}),
};

function config(turnLimit = 8, tools: readonly ToolDefinition[] = [readFile]): HarnessConfig {
	return {
		model: "test-model",
		system: "you are a test",
		tools: toolRegistry(tools),
		turnLimit,
	};
}

function done(stopReason: "stop" | "toolUse"): ProviderEvent {
	return {
		type: "done",
		stopReason,
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
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

/** A latch the test waits on and the provider opens. */
function latch(): { readonly open: Promise<void>; readonly release: () => void } {
	let release: () => void = () => {};
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { open, release };
}

/** Collects the entries, and fails if they do not end. */
async function collect(entries: AsyncIterable<JournalEntry>, ms = 1000): Promise<JournalEntry[]> {
	const collected: JournalEntry[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`the entries did not end within ${ms}ms`)), ms);
	});
	try {
		await Promise.race([
			(async () => {
				for await (const entry of entries) collected.push(entry);
			})(),
			timeout,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	return collected;
}

describe("the receiving side of the exchange", () => {
	test("a task we take is accepted, and the peer is told", async () => {
		const peer = fakePort();
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: scriptedProvider([[done("stop")]]) },
		});

		peer.fromPeer(offer());

		const accepts = peer.sent.filter((frame) => frame.kind === "accept");
		expect(accepts).toHaveLength(1);
		expect(accepts[0]?.taskId).toBe("t1");
		// The peer is told before the run starts, not after it ends.
		expect(peer.sent[0]?.kind).toBe("accept");
		expect(await settles(task.outcome)).toEqual({ kind: "completed" });
	});

	test("a task the host will not take is refused, and the reason is told", async () => {
		const peer = fakePort();
		let asked = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			asked += 1;
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
			decide: (offer): TaskDecision =>
				offer.task.includes("a.txt") ? { kind: "refuse", reason: "not ours to read" } : { kind: "accept" },
		});

		peer.fromPeer(offer());

		const refuses = peer.sent.filter((frame) => frame.kind === "refuse");
		expect(refuses).toHaveLength(1);
		const reason = refuses[0]?.kind === "refuse" ? refuses[0].reason : "";
		expect(reason).toBe("not ours to read");
		expect(peer.sent.filter((frame) => frame.kind === "accept")).toHaveLength(0);

		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		// The failure carries the refusal: the reason the peer was told.
		expect(outcome.kind === "failed" ? outcome.error : undefined).toEqual({ reason: "not ours to read" });
		// The task was refused, so the run never started.
		expect(asked).toBe(0);
	});

	test("a refusal without a reason is given one", async () => {
		const peer = fakePort();
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: scriptedProvider([[done("stop")]]) },
			decide: (): TaskDecision => ({ kind: "refuse", reason: "" }),
		});

		peer.fromPeer(offer());

		// A refusal without a reason is a shrug, and a shrug is not a refusal the
		// peer can act on.
		const refuses = peer.sent.filter((frame) => frame.kind === "refuse");
		expect(refuses).toHaveLength(1);
		const reason = refuses[0]?.kind === "refuse" ? refuses[0].reason : "";
		expect(reason.length).toBeGreaterThan(0);

		// And the task ends with the reason the peer was told.
		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(outcome.kind === "failed" ? outcome.error : undefined).toEqual({ reason });
	});

	test("a refusal may declare what this side can do, and the peer is told", async () => {
		const peer = fakePort();
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: scriptedProvider([[done("stop")]]) },
			decide: (): TaskDecision => ({
				kind: "refuse",
				reason: "not ours to read",
				declaration: "data, not compute",
			}),
		});

		peer.fromPeer(offer());

		// The declaration travels with the refusal: the peer can show it to its own
		// user, and it must not have to ask for it again.
		const refuses = peer.sent.filter((frame) => frame.kind === "refuse");
		expect(refuses).toHaveLength(1);
		const refusal = refuses[0];
		expect(refusal?.kind === "refuse" ? refusal.reason : undefined).toBe("not ours to read");
		expect(refusal?.kind === "refuse" ? refusal.declaration : undefined).toBe("data, not compute");

		// And the task ends with the whole refusal: nothing the peer said is dropped.
		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(outcome.kind === "failed" ? outcome.error : undefined).toEqual({
			reason: "not ours to read",
			declaration: "data, not compute",
		});
	});

	test("a refusal without a declaration carries only the reason", async () => {
		const peer = fakePort();
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: scriptedProvider([[done("stop")]]) },
			decide: (): TaskDecision => ({ kind: "refuse", reason: "not ours to read" }),
		});

		peer.fromPeer(offer());

		const refuses = peer.sent.filter((frame) => frame.kind === "refuse");
		expect(refuses).toHaveLength(1);
		expect(refuses[0]?.kind === "refuse" ? refuses[0].declaration : undefined).toBeUndefined();

		const outcome = await settles(task.outcome);
		expect(outcome.kind === "failed" ? outcome.error : undefined).toEqual({ reason: "not ours to read" });
	});

	test("a host that cannot decide refuses the task, and the task ends", async () => {
		const peer = fakePort();
		let asked = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			asked += 1;
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
			decide: () => {
				throw new Error("the policy store is down");
			},
		});

		peer.fromPeer(offer());

		// A host that cannot decide is a refusal with a reason, not a silence.
		const refuses = peer.sent.filter((frame) => frame.kind === "refuse");
		expect(refuses).toHaveLength(1);
		const reason = refuses[0]?.kind === "refuse" ? refuses[0].reason : "";
		expect(reason.length).toBeGreaterThan(0);
		expect(reason).toContain("the policy store is down");
		expect(peer.sent.filter((frame) => frame.kind === "accept")).toHaveLength(0);

		// And the task ends: the peer is not left waiting for an answer.
		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(asked).toBe(0);
	});

	test("an offer without a task is refused, and the reason is told", async () => {
		const peer = fakePort();
		let asked = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			asked += 1;
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		// A malformed offer: there is no task in it.
		peer.fromPeer({ kind: "offer", version: protocolVersion, taskId: "t1" });

		const refuses = peer.sent.filter((frame) => frame.kind === "refuse");
		expect(refuses).toHaveLength(1);
		const reason = refuses[0]?.kind === "refuse" ? refuses[0].reason : "";
		expect(reason.length).toBeGreaterThan(0);
		expect(peer.sent.filter((frame) => frame.kind === "accept")).toHaveLength(0);

		// The run never started: there was nothing to run.
		expect(asked).toBe(0);
		expect((await settles(task.outcome)).kind).toBe("failed");
	});

	test("a peer that speaks another version is refused, and the reason is told", async () => {
		const peer = fakePort();
		let asked = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			asked += 1;
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer(offer({ version: 2 }));

		const refuses = peer.sent.filter((frame) => frame.kind === "refuse");
		expect(refuses).toHaveLength(1);
		const reason = refuses[0]?.kind === "refuse" ? refuses[0].reason : "";
		expect(reason).toContain("2");
		expect(reason.length).toBeGreaterThan(0);
		expect(peer.sent.filter((frame) => frame.kind === "accept")).toHaveLength(0);

		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(asked).toBe(0);
	});

	test("the run's journal entries reach the peer, in the order they were written", async () => {
		const peer = fakePort();
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "done" }, done("stop")],
		];
		const journal: JournalEntry[] = [];
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: {
				callProvider: scriptedProvider(script),
				append: (entry) => journal.push(entry),
			},
		});

		peer.fromPeer(offer());
		await settles(task.outcome);

		const entries = sentEntries(peer.sent);
		expect(entries.map((entry) => entry.kind)).toEqual([
			"message",
			"message",
			"tool_call",
			"tool_result",
			"message",
		]);
		// The entries are the journal's own: they carry its sequence.
		expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
		// The result ends the task, and it ends it after the last entry.
		const kinds = peer.sent.map((frame) => frame.kind);
		expect(kinds[kinds.length - 1]).toBe("result");
		// Our own host keeps the same log: the peer is not the only reader.
		expect(journal).toEqual(entries);
		// The local view is the same log.
		expect(await collect(task.events)).toEqual(entries);
	});

	test("a journal hook that throws ends the task, and the peer keeps what was written", async () => {
		const peer = fakePort();
		let written = 0;
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: {
				callProvider: scriptedProvider([[done("stop")]]),
				append: () => {
					written += 1;
					// The second entry cannot be written.
					if (written === 2) throw new Error("the disk is full");
				},
			},
		});

		peer.fromPeer(offer());

		// The task ends with a failure that says so: the peer is not left waiting.
		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(String(outcome.kind === "failed" ? outcome.error : undefined)).toContain("the disk is full");

		// The peer has the entries that were written before the failure, and not the
		// one that could not be written: the peer gets what we wrote.
		const entries = sentEntries(peer.sent);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.kind).toBe("message");

		// And the peer was told how the task ended.
		const results = peer.sent.filter((frame) => frame.kind === "result");
		expect(results).toHaveLength(1);
	});

	test("a transport that throws ends the task, and the peer is not left waiting", async () => {
		// The transport is broken from the first frame on.
		const peer = fakePort(undefined, () => true);
		let asked = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			asked += 1;
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer(offer());

		// The task ends as a failure carrying the reason: a peer that waits for an
		// answer that is not coming is a peer that waits forever.
		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(String(outcome.kind === "failed" ? outcome.error : undefined)).toContain(
			"the peer could not be reached",
		);
		expect(String(outcome.kind === "failed" ? outcome.error : undefined)).toContain("the socket is closed");
		// The run never started: the peer never heard the accept.
		expect(asked).toBe(0);
		expect(peer.sent).toHaveLength(0);
	});

	test("a transport that breaks mid-run ends the task, and the journal keeps its entries", async () => {
		const journal: JournalEntry[] = [];
		let events = 0;
		const peer = fakePort(undefined, (frame) => {
			if (frame.kind !== "event") return false;
			events += 1;
			// The second entry cannot be delivered.
			return events > 1;
		});
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: {
				callProvider: scriptedProvider([[done("stop")]]),
				append: (entry) => journal.push(entry),
			},
		});

		peer.fromPeer(offer());

		const outcome = await settles(task.outcome);
		expect(outcome.kind).toBe("failed");
		expect(String(outcome.kind === "failed" ? outcome.error : undefined)).toContain(
			"the peer could not be reached",
		);

		// The run's own journal keeps the entries it wrote: the failure is in the
		// communication, not in the run.
		expect(journal.length).toBeGreaterThanOrEqual(2);
		// And the peer has the entries that went before the transport broke.
		expect(sentEntries(peer.sent)).toHaveLength(1);
	});

	test("every frame we send carries our task id", async () => {
		const peer = fakePort();
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: scriptedProvider([[done("stop")]]) },
		});

		peer.fromPeer(offer());
		await settles(task.outcome);

		// A frame for another task is not ours, and the peer would drop it.
		expect(peer.sent.length).toBeGreaterThan(1);
		for (const frame of peer.sent) expect(frame.taskId).toBe("t1");
	});

	test("the task ends with the run's own outcome", async () => {
		const peer = fakePort();
		// The run stops at the turn limit, so its outcome is not the one a run that
		// finished would have.
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(1),
			host: { callProvider: scriptedProvider([[done("stop")]]) },
		});

		peer.fromPeer(offer());

		expect(await settles(task.outcome)).toEqual({ kind: "limitReached", turns: 1 });
		// The outcome is sent once: the task ends once.
		const results = peer.sent.filter((frame) => frame.kind === "result");
		expect(results).toHaveLength(1);
		expect(sentOutcome(peer.sent)).toEqual({ kind: "limitReached", turns: 1 });
	});

	test("the peer has the entries while the run is still going", async () => {
		const peer = fakePort();
		const waiting = latch();
		const secondTurn = latch();
		let turn = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			turn += 1;
			if (turn === 1) {
				yield { type: "tool_call_start", id: "c1", name: "read_file" };
				yield { type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' };
				yield done("toolUse");
				return;
			}
			// The second turn waits for the test: the run is still going.
			secondTurn.release();
			await waiting.open;
			yield done("stop");
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer(offer());
		await secondTurn.open;

		// The entries are sent as they are written, so the peer already has the
		// first turn's entries — while the run is still going.
		expect(peer.sent.filter((frame) => frame.kind === "result")).toHaveLength(0);
		expect(sentEntries(peer.sent).map((entry) => entry.kind)).toEqual([
			"message",
			"message",
			"tool_call",
			"tool_result",
		]);

		waiting.release();
		expect(await settles(task.outcome)).toEqual({ kind: "completed" });
	});

	test("the peer is told the task is over only after our own tool has settled", async () => {
		let settled = false;
		const running = latch();
		const slowRead: ToolDefinition = {
			...readFile,
			execute: async (_call, _args, signal) => {
				running.release();
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				// A tool that takes its time to notice the abort.
				await new Promise((resolve) => setTimeout(resolve, 20));
				settled = true;
				throw new Error("the tool was aborted");
			},
		};
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
		];
		// What the peer could see at the moment it was told something.
		const told: { readonly frame: ExchangeFrame; readonly settled: boolean }[] = [];
		const peer = fakePort((frame) => told.push({ frame, settled }));
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(8, [slowRead]),
			host: { callProvider: scriptedProvider(script) },
		});

		peer.fromPeer(offer());
		await running.open;
		peer.fromPeer({ kind: "cancel", taskId: "t1" });

		expect(await settles(task.outcome)).toEqual({ kind: "cancelled" });

		// The tool had settled when the peer was told the task was over: the peer
		// must not be told that the task is over while our own work is running.
		const results = told.filter((entry) => entry.frame.kind === "result");
		expect(results).toHaveLength(1);
		expect(results[0]?.settled).toBe(true);
		// And the peer was told before the tool settled, so the wait was real.
		expect(told.filter((entry) => entry.settled === false).length).toBeGreaterThan(0);
	});

	test("the peer is told the task is over only after our own provider has let go", async () => {
		let cleanedUp = false;
		const provider: HarnessHost["callProvider"] = async function* () {
			try {
				yield done("stop");
			} finally {
				// A provider that takes its time to let go of the call.
				await new Promise((resolve) => setTimeout(resolve, 20));
				cleanedUp = true;
			}
		};
		// What the peer could see at the moment it was told something.
		const told: { readonly frame: ExchangeFrame; readonly cleanedUp: boolean }[] = [];
		const peer = fakePort((frame) => told.push({ frame, cleanedUp }));
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer(offer());

		expect(await settles(task.outcome)).toEqual({ kind: "completed" });

		const results = told.filter((entry) => entry.frame.kind === "result");
		expect(results).toHaveLength(1);
		expect(results[0]?.cleanedUp).toBe(true);
	});

	test("a cancel from the peer stops the run", async () => {
		const peer = fakePort();
		const running = latch();
		let aborted = false;
		const provider: HarnessHost["callProvider"] = async function* (_request, signal) {
			running.release();
			await new Promise<void>((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve();
					},
					{ once: true },
				);
			});
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer(offer());
		await running.open;
		peer.fromPeer({ kind: "cancel", taskId: "t1" });

		expect(await settles(task.outcome)).toEqual({ kind: "cancelled" });
		// The run stopped: the provider was cut short.
		expect(aborted).toBe(true);
		expect(sentOutcome(peer.sent)).toEqual({ kind: "cancelled" });
	});

	test("a cancel before the offer means the task is not taken", async () => {
		const peer = fakePort();
		let asked = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			asked += 1;
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		// The peer withdrew the task before offering it.
		peer.fromPeer({ kind: "cancel", taskId: "t1" });
		peer.fromPeer(offer());

		// It does not want the task, so it is not taken.
		expect(peer.sent.filter((frame) => frame.kind === "accept")).toHaveLength(0);
		expect(asked).toBe(0);
		// And the task ends: the peer is not left waiting for an answer.
		expect(await settles(task.outcome)).toEqual({ kind: "cancelled" });
		expect(sentOutcome(peer.sent)).toEqual({ kind: "cancelled" });
	});

	test("a frame for another task is not ours", async () => {
		const peer = fakePort();
		let asked = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			asked += 1;
		};
		receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer(offer({ taskId: "other" }));
		peer.fromPeer({ kind: "cancel", taskId: "other" });

		expect(peer.sent).toHaveLength(0);
		expect(asked).toBe(0);
	});

	test("a cancel for another task does not stop our run", async () => {
		const peer = fakePort();
		const running = latch();
		let aborted = false;
		const provider: HarnessHost["callProvider"] = async function* (_request, signal) {
			running.release();
			await new Promise<void>((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve();
					},
					{ once: true },
				);
			});
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer(offer());
		await running.open;
		peer.fromPeer({ kind: "cancel", taskId: "other" });

		expect(aborted).toBe(false);
		peer.fromPeer({ kind: "cancel", taskId: "t1" });
		expect(await settles(task.outcome)).toEqual({ kind: "cancelled" });
	});

	test("a frame we do not know is ignored", async () => {
		const peer = fakePort();
		receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: scriptedProvider([[done("stop")]]) },
		});

		peer.fromPeer(null);
		peer.fromPeer(42);
		peer.fromPeer("offer");
		peer.fromPeer({ kind: "unknown", taskId: "t1" });
		peer.fromPeer({ kind: "call", taskId: "t1", callId: "c1", tool: "read_file" });

		expect(peer.sent).toHaveLength(0);
	});

	test("a peer never gets a handle on our tools", async () => {
		const peer = fakePort();
		let executed = 0;
		const counting: ToolDefinition = {
			...readFile,
			execute: async () => {
				executed += 1;
				return { content: [] };
			},
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(8, [counting]),
			host: { callProvider: scriptedProvider([[done("stop")]]) },
		});

		// A frame of an older protocol: the peer asking to call our tool.
		peer.fromPeer({ kind: "call", taskId: "t1", callId: "c1", tool: "read_file", args: { path: "a.txt" } });
		peer.fromPeer(offer());
		await settles(task.outcome);

		// The call was ignored: our tool did not run because the peer asked.
		expect(executed).toBe(0);
		for (const frame of peer.sent) {
			expect(frame.kind).not.toBe("call");
			expect("tools" in frame).toBe(false);
		}
	});

	test("the peer's offer cannot change our tools", async () => {
		const peer = fakePort();
		let asked: readonly ToolDefinition[] = [];
		const provider: HarnessHost["callProvider"] = async function* (request: ProviderRequest) {
			asked = request.tools;
			yield done("stop");
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer({
			...offer(),
			tools: [{ name: "shell", description: "runs a command", parameters: { kind: "object", properties: {} } }],
		});
		await settles(task.outcome);

		expect(asked.map((tool) => tool.name)).toEqual(["read_file"]);
	});

	test("the run starts with the task and the context the peer sent", async () => {
		const peer = fakePort();
		let asked: readonly { readonly role: string; readonly content: unknown }[] = [];
		const provider: HarnessHost["callProvider"] = async function* (request: ProviderRequest) {
			asked = request.messages;
			yield done("stop");
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer(offer({ task: "read a.txt", context: "from the browser" }));
		await settles(task.outcome);

		expect(asked).toHaveLength(1);
		expect(asked[0]?.role).toBe("user");
		const content = typeof asked[0]?.content === "string" ? asked[0].content : "";
		expect(content).toContain("read a.txt");
		expect(content).toContain("from the browser");
	});

	test("the result comes after the last entry, even when a tool is slow to stop", async () => {
		const peer = fakePort();
		const running = latch();
		const slowRead: ToolDefinition = {
			...readFile,
			execute: async (_call, _args, signal) => {
				running.release();
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				// A tool that takes its time to notice the abort.
				await new Promise((resolve) => setTimeout(resolve, 20));
				throw new Error("the tool was aborted");
			},
		};
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
		];
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(8, [slowRead]),
			host: { callProvider: scriptedProvider(script) },
		});

		peer.fromPeer(offer());
		await running.open;
		peer.fromPeer({ kind: "cancel", taskId: "t1" });

		expect(await settles(task.outcome)).toEqual({ kind: "cancelled" });

		// The answer to the cancelled call reached the peer before the result: the
		// peer closes its journal when the result arrives, and an entry that came
		// after it would be lost.
		const kinds = peer.sent.map((frame) => frame.kind);
		expect(kinds[kinds.length - 1]).toBe("result");
		expect(sentEntries(peer.sent).map((entry) => entry.kind)).toEqual([
			"message",
			"message",
			"tool_call",
			"tool_result",
		]);
	});

	test("cancelling the task here stops the run as well", async () => {
		const peer = fakePort();
		const running = latch();
		let aborted = false;
		const provider: HarnessHost["callProvider"] = async function* (_request, signal) {
			running.release();
			await new Promise<void>((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve();
					},
					{ once: true },
				);
			});
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer(offer());
		await running.open;
		task.cancel();

		expect(await settles(task.outcome)).toEqual({ kind: "cancelled" });
		expect(aborted).toBe(true);
	});

	test("the run uses our own policy: the host's approve seam applies", async () => {
		const peer = fakePort();
		let executed = 0;
		const counting: ToolDefinition = {
			...readFile,
			execute: async () => {
				executed += 1;
				return { content: [] };
			},
		};
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "denied" }, done("stop")],
		];
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(8, [counting]),
			host: {
				callProvider: scriptedProvider(script),
				approve: async () => ({ kind: "deny", reason: "not allowed here" }),
			},
		});

		peer.fromPeer(offer());
		await settles(task.outcome);

		// The call was refused by our own host, so our tool did not run.
		expect(executed).toBe(0);
		// And the refusal is in the journal the peer received.
		const entries = sentEntries(peer.sent);
		const refusal = entries.find((entry) => entry.kind === "block");
		expect(refusal?.kind).toBe("block");
		expect(refusal?.kind === "block" ? refusal.reason : "").toBe("not allowed here");
	});

	test("the approve seam sees our tool as it is: the same name, the same dialect", async () => {
		const peer = fakePort();
		const own: ToolDefinition = {
			...readFile,
			execute: async () => ({ content: [] }),
		};
		let seen: ToolDefinition | undefined;
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "done" }, done("stop")],
		];
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(8, [own]),
			host: {
				callProvider: scriptedProvider(script),
				approve: async (context) => {
					seen = context.tool;
					return { kind: "allow" };
				},
			},
		});

		peer.fromPeer(offer());
		await settles(task.outcome);

		// The seam saw our tool as it is: the same name, the same dialect, the same
		// behaviour. Only the reference differs — the receiving side counts the
		// running promises, and only a wrapper can do that (ADR 0011 D81).
		expect(seen?.name).toBe(own.name);
		expect(seen?.description).toBe(own.description);
		expect(seen?.parameters).toEqual(own.parameters);
	});

	test("a second offer for the same task does not start a second run", async () => {
		const peer = fakePort();
		let asked = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			asked += 1;
			yield done("stop");
		};
		const task = receive({
			port: peer.port,
			taskId: "t1",
			config: config(),
			host: { callProvider: provider },
		});

		peer.fromPeer(offer());
		await settles(task.outcome);
		peer.fromPeer(offer());

		expect(asked).toBe(1);
		expect(peer.sent.filter((frame) => frame.kind === "accept")).toHaveLength(1);
		expect(peer.sent.filter((frame) => frame.kind === "result")).toHaveLength(1);
	});
});
