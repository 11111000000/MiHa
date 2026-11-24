import { describe, expect, test } from "bun:test";
import { runAgent, type HarnessHost } from "../src/core/loop.ts";
import { initialState, step, type HarnessConfig, type ProviderRequest } from "../src/core/run.ts";
import type { AgentEvent, ProviderEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import { userMessage, type AgentMessage, type ToolResultMessage } from "../src/core/messages.ts";

/**
 * The request seam (ADR 0006 D35).
 *
 * The host may rewrite the provider request in flight: elide a stale result, switch
 * the model for one turn, attach a deadline. What the tests pin down:
 *
 *   - the seam runs between the core's request and the provider's call
 *   - the provider receives exactly what the seam returned
 *   - a seam that throws becomes a provider error the run reports, not a dead run
 *   - a host without the seam changes nothing
 *   - the seam is given the run's signal, so a host can see the abort
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

async function collect(run: ReturnType<typeof runAgent>) {
	const events: AgentEvent[] = [];
	for await (const event of run) events.push(event);
	return { events, outcome: await run.result() };
}

/** The transcript the run ended with — the messages, in the order they were recorded. */
function transcriptOf(events: readonly AgentEvent[]): readonly AgentMessage[] {
	const end = events.find((event) => event.type === "agent_end");
	if (!end || end.type !== "agent_end") throw new Error("no agent_end");
	return end.messages;
}

/** The tool results of a transcript, in the order they were recorded (law T4). */
function toolResultsOf(events: readonly AgentEvent[]): readonly ToolResultMessage[] {
	return transcriptOf(events).filter(
		(message): message is ToolResultMessage => message.role === "toolResult",
	);
}

/** The request the core builds for the first turn — the one the provider must see. */
function coreRequest(cfg: HarnessConfig, message: AgentMessage): ProviderRequest {
	const outputs = step(initialState(cfg), { kind: "prompt", message }).outputs;
	const intent = outputs.find((output) => output.kind === "provider_request");
	if (!intent || intent.kind !== "provider_request") throw new Error("no provider request");
	return intent.request;
}

/** A latch the test waits on and the seam opens. */
function latch(): { readonly open: Promise<void>; readonly release: () => void } {
	let release: () => void = () => {};
	const open = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { open, release };
}

/**
 * Whether a promise settles within the window.
 *
 * Some of what the driver does happens after the run's last event, so the
 * test has to wait for it — and a promise that never settles must not hang
 * the test.
 */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([promise.then(() => true), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * A signal the test can watch.
 *
 * A real `AbortSignal` drops a `once` listener by itself when it fires, which
 * hides what the driver does with the host's signal. The spy counts the
 * removals the driver asks for, so the test sees whether the driver let go of
 * the host's signal when the run ended.
 */
function spySignal(): {
	readonly signal: AbortSignal;
	readonly abort: () => void;
	readonly released: Promise<void>;
} {
	const controller = new AbortController();
	const real = controller.signal;
	let released: () => void = () => {};
	const gone = new Promise<void>((resolve) => {
		released = resolve;
	});
	const spy = {
		get aborted(): boolean {
			return real.aborted;
		},
		get reason(): unknown {
			return real.reason;
		},
		addEventListener: (_type: string, listener: () => void, _options?: unknown): void => {
			real.addEventListener("abort", () => listener());
		},
		removeEventListener: (_type: string, _listener: () => void, _options?: unknown): void => {
			released();
		},
	} as unknown as AbortSignal;
	return { signal: spy, abort: () => controller.abort(), released: gone };
}

describe("the request seam", () => {
	test("the provider receives exactly what the seam returned", async () => {
		const returned: ProviderRequest = {
			model: "switched-model",
			system: "you are a test",
			messages: [],
			tools: [],
		};
		let seen: ProviderRequest | undefined;
		const run = runAgent(
			config(),
			{
				callProvider: async function* (request) {
					seen = request;
					yield done("stop");
				},
				prepareRequest: () => returned,
			},
			{ message: userMessage("hello") },
		);

		await collect(run);

		// The very object the seam returned — not a copy of it, not the core's.
		expect(seen).toBe(returned);
	});

	test("the seam runs before the provider is called", async () => {
		const order: string[] = [];
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					order.push("provider");
					yield done("stop");
				},
				prepareRequest: (request) => {
					order.push("seam");
					return request;
				},
			},
			{ message: userMessage("hello") },
		);

		await collect(run);

		expect(order).toEqual(["seam", "provider"]);
	});

	test("an async seam is awaited before the provider is called", async () => {
		let seen: ProviderRequest | undefined;
		const run = runAgent(
			config(),
			{
				callProvider: async function* (request) {
					seen = request;
					yield done("stop");
				},
				prepareRequest: async (request) => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return { ...request, model: "switched-model" };
				},
			},
			{ message: userMessage("hello") },
		);

		await collect(run);

		expect(seen?.model).toBe("switched-model");
	});

	test("the seam is asked once per provider request, and sees that request", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "done" }, done("stop")],
		];
		const asked: ProviderRequest[] = [];
		let providerCalls = 0;
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					const events = script[providerCalls] ?? [];
					providerCalls += 1;
					for (const event of events) yield event;
				},
				prepareRequest: (request) => {
					asked.push(request);
					return request;
				},
			},
			{ message: userMessage("read a.txt") },
		);

		const { outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		expect(asked).toHaveLength(2);
		expect(providerCalls).toBe(2);

		// The first request carries the prompt, the second the first turn's answer:
		// the seam is asked about the request that is about to be made.
		const first = asked[0];
		expect(first?.model).toBe("test-model");
		expect(first?.messages).toHaveLength(1);
		const second = asked[1];
		expect(second?.messages.some((message) => message.role === "toolResult")).toBe(true);
	});

	test("a seam that throws becomes a provider error the run reports", async () => {
		let asked = 0;
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					asked += 1;
					yield done("stop");
				},
				prepareRequest: () => {
					throw new Error("the host could not prepare the request");
				},
			},
			{ message: userMessage("hello") },
		);

		const { events, outcome } = await collect(run);

		// The provider is not called: the request never became one.
		expect(asked).toBe(0);
		// The run reports it the way it reports any other provider failure.
		expect(outcome).toEqual({ kind: "completed" });
		const assistant = transcriptOf(events).find((message) => message.role === "assistant");
		if (!assistant || assistant.role !== "assistant") throw new Error("no assistant message");
		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toContain("the host could not prepare the request");
	});

	test("a seam that throws leaves the batch's calls answered (law M1)", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[],
		];
		let turn = 0;
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					const events = script[turn] ?? [];
					turn += 1;
					for (const event of events) yield event;
				},
				prepareRequest: (request) => {
					// The first turn is prepared; the second one is not.
					if (turn > 0) throw new Error("the host gave up");
					return request;
				},
			},
			{ message: userMessage("read a.txt") },
		);

		const { events } = await collect(run);

		const results = toolResultsOf(events);
		expect(results).toHaveLength(1);
		expect(results[0]?.toolCallId).toBe("c1");
		expect(results[0]?.isError).toBe(false);
	});

	test("the seam is given the run's signal, so a host can see the abort", async () => {
		const controller = new AbortController();
		const inside = latch();
		let seen: AbortSignal | undefined;
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					yield done("stop");
				},
				prepareRequest: async (request, signal) => {
					seen = signal;
					inside.release();
					await new Promise<void>((resolve) => {
						if (signal.aborted) resolve();
						else signal.addEventListener("abort", () => resolve(), { once: true });
					});
					return request;
				},
			},
			{ message: userMessage("hello"), signal: controller.signal },
		);

		await inside.open;
		controller.abort();

		// The seam holds the run's signal: the abort reached it.
		expect(seen?.aborted).toBe(true);

		await collect(run);
	});

	test("with no seam, the provider receives the core's request untouched", async () => {
		const options = { temperature: 0.2 };
		const cfg: HarnessConfig = { ...config(), options };
		const message = userMessage("hello");
		let seen: ProviderRequest | undefined;
		const run = runAgent(
			cfg,
			{
				callProvider: async function* (request) {
					seen = request;
					yield done("stop");
				},
			},
			{ message },
		);

		await collect(run);

		// The request the core built, unchanged.
		expect(seen).toEqual(coreRequest(cfg, message));
		// And the host's own objects, not copies of them.
		expect(seen?.tools[0]).toBe(readFile);
		expect(seen?.options).toBe(options);
	});

	test("the rewrite is applied to every request, not only to the first", async () => {
		const script: readonly (readonly ProviderEvent[])[] = [
			[
				{ type: "tool_call_start", id: "c1", name: "read_file" },
				{ type: "tool_arguments_delta", id: "c1", delta: '{"path":"a.txt"}' },
				done("toolUse"),
			],
			[{ type: "text_delta", delta: "done" }, done("stop")],
		];
		const models: string[] = [];
		const rewrites: string[] = [];
		let turn = 0;
		const run = runAgent(
			config(),
			{
				callProvider: async function* (request) {
					models.push(request.model);
					const events = script[turn] ?? [];
					turn += 1;
					for (const event of events) yield event;
				},
				prepareRequest: (request) => {
					rewrites.push(request.model);
					return { ...request, model: `rewritten-${rewrites.length}` };
				},
			},
			{ message: userMessage("read a.txt") },
		);

		const { outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		// The seam was asked about both requests, and both of them went to the
		// provider rewritten. A rewrite that reached only the first turn would
		// leave the second one as the core built it.
		expect(rewrites).toEqual(["test-model", "test-model"]);
		expect(models).toEqual(["rewritten-1", "rewritten-2"]);
	});

	test("the seam sees the options bag the core built", async () => {
		// The bag is how a host reaches a provider knob — MiniMax's
		// `reasoning_split` rides in it — so the seam has to see it.
		const options = { reasoning_split: true, temperature: 0.2 };
		const cfg: HarnessConfig = { ...config(), options };
		let seen: ProviderRequest | undefined;
		const run = runAgent(
			cfg,
			{
				callProvider: async function* () {
					yield done("stop");
				},
				prepareRequest: (request) => {
					seen = request;
					return request;
				},
			},
			{ message: userMessage("hello") },
		);

		await collect(run);

		expect(seen?.options).toEqual(options);
	});

	test("the seam is given a live signal, and the run's end aborts it", async () => {
		// A run without an external signal still hands the seam a signal of its
		// own: the run's merged one. It is alive while the run lasts, and the
		// end of the run aborts it.
		let seen: AbortSignal | undefined;
		let abortedWhenAsked: boolean | undefined;
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					yield done("stop");
				},
				prepareRequest: (request, signal) => {
					seen = signal;
					abortedWhenAsked = signal.aborted;
					return request;
				},
			},
			{ message: userMessage("hello") },
		);

		await collect(run);

		expect(seen).toBeDefined();
		expect(abortedWhenAsked).toBe(false);
		// The run is over, so the signal it handed out is aborted too.
		expect(seen?.aborted).toBe(true);
	});

	test("a cancelled run does not call the provider", async () => {
		const controller = new AbortController();
		const entered = latch();
		const release = latch();
		const called = latch();
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					called.release();
					yield done("stop");
				},
				prepareRequest: async (request) => {
					entered.release();
					await release.open;
					return request;
				},
			},
			{ message: userMessage("hello"), signal: controller.signal },
		);

		await entered.open;
		controller.abort();
		release.release();

		// The request was never performed: the run was cancelled while the seam
		// was waiting for it.
		expect(await within(called.open, 200)).toBe(false);
		await collect(run);
	});

	test("a cancelled run does not wait for a seam that ignores the signal", async () => {
		const spy = spySignal();
		const entered = latch();
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					yield done("stop");
				},
				prepareRequest: async (request) => {
					entered.release();
					// A seam that ignores the abort: it never answers.
					await new Promise<ProviderRequest>(() => {});
					return request;
				},
			},
			{ message: userMessage("hello"), signal: spy.signal },
		);

		await entered.open;
		spy.abort();

		// The driver lets go of the host's signal: the run ended at the
		// cancellation, and it did not wait for a seam that ignores the abort.
		expect(await within(spy.released, 200)).toBe(true);
		await collect(run);
	});

	test("a seam that returns nothing is refused, and the provider is not asked", async () => {
		let asked = 0;
		// A seam that forgets its `return` — what a JavaScript host does.
		const broken = (() => undefined) as unknown as NonNullable<HarnessHost["prepareRequest"]>;
		const run = runAgent(
			config(),
			{
				callProvider: async function* () {
					asked += 1;
					yield done("stop");
				},
				prepareRequest: broken,
			},
			{ message: userMessage("hello") },
		);

		const { events, outcome } = await collect(run);

		// The provider is not asked: a request that was never built is not one
		// that can be performed.
		expect(asked).toBe(0);
		// And the run reports it the way it reports any other provider failure.
		expect(outcome).toEqual({ kind: "completed" });
		const assistant = transcriptOf(events).find((message) => message.role === "assistant");
		if (!assistant || assistant.role !== "assistant") throw new Error("no assistant message");
		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toContain("the host returned no request");
	});
});
