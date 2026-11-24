/**
 * The browser example: the harness in a worker, the application in the page.
 *
 * This file decides the claim `browser-example`:
 *
 *   The harness runs in a browser: an example application embeds it in a worker,
 *   the agent calls the application's own tools through the bridge, a refusal asks
 *   the human and the run continues, the journal reaches the page as it is written,
 *   and the whole example bundles well inside the ceiling.
 *
 * **There is no browser here**, and that is a fact about the evidence rather than
 * about the claim: a machine cannot open a page. So the test decides the parts of
 * the claim that are decidable without one, and it decides them by running the
 * example's own two halves against each other:
 *
 * - the example's sources exist, and they are wired to the harness's **public
 *   API** — the barrels, and nothing below them;
 * - the build produces bundles whose gzipped size is under the ceiling — the number
 *   the budget check enforces, measured on the example rather than on a synthetic
 *   entry that re-exports the barrels;
 * - the page and the worker **agree on the bridge's shape**: every frame one side
 *   sends, the other side accepts;
 * - and the whole round trip runs — the agent's tools are the page's own, a call
 *   reaches the page's capability through the bridge, a refusal asks the human and
 *   the run continues, and the journal reaches the page as it is written.
 *
 * The provider answers from a script instead of from a network: the evidence copy
 * has no key and no socket, and a live provider is not a verifier.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type {
	AgentEvent,
	JournalEntry,
	Outcome,
	ProviderEvent,
	ProviderRequest,
	ToolDefinition,
} from "../src/core/index.ts";
import type { ProviderFn } from "../src/llm/index.ts";
import { createWorkerHost } from "../src/worker/host.ts";
import type { WorkerHost, WorkerLike } from "../src/worker/host.ts";
import type { CapabilityFn, Channel } from "../src/worker/protocol.ts";
import {
	decisionFrame,
	approveFrame,
	cancelFrame,
	isDecisionFrame,
	isApproveFrame,
	isCancelFrame,
	isJournalFrame,
	isNoteFrame,
	isPeerJournalFrame,
	isPeerOutcomeFrame,
	isPeerOfferFrame,
	isRunFrame,
	journalFrame,
	noteFrame,
	peerJournalFrame,
	peerOfferFrame,
	peerOutcomeFrame,
	runFrame,
	PAGE_TO_WORKER_KINDS,
	WORKER_TO_PAGE_KINDS,
	type ApprovalRequest,
	type HumanDecision,
	type OfferedTool,
} from "../examples/browser/frames.ts";
import { capabilities, catalogue, seedDirectory } from "../examples/browser/tools.ts";
import { createPageApp } from "../examples/browser/page.ts";
import { createWorkerApp } from "../examples/browser/worker.ts";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE = join(ROOT, "examples/browser");

/**
 * The bundle ceiling: ADR 0004 D19, the same number `scripts/check-budget.mjs`
 * enforces. The example is not a layer and is not in the layer budgets, but it
 * must not push the browser bundle over the ceiling either.
 */
const CEILING = 30_000;

/**
 * The harness's public API, as the example may reach it.
 *
 * The barrels, and the worker layer's own modules — the harness has no worker
 * barrel, and the bridge is how a worker asks the page for something. Anything
 * below these is the core's internals, and an example that reaches into them is
 * not embedding the harness: it is copying it.
 */
const PUBLIC_API = new Set([
	"src/index.ts",
	"src/core/index.ts",
	"src/llm/index.ts",
	"src/exchange/index.ts",
	"src/worker/host.ts",
	"src/worker/bridge.ts",
	"src/worker/protocol.ts",
]);

/** The example's sources, by name. */
const SOURCES = [
	"index.html",
	"frames.ts",
	"tools.ts",
	"page.ts",
	"page.entry.ts",
	"worker.ts",
	"worker.entry.ts",
	"peer.ts",
	"provider.ts",
	"measure.mjs",
	"build.sh",
	"smoke.sh",
] as const;

/** The import specifiers of one source. */
function importsOf(file: string): readonly string[] {
	const text = readFileSync(file, "utf8");
	const found: string[] = [];
	for (const match of text.matchAll(/\bfrom\s+"([^"]+)"/g)) found.push(match[1] as string);
	for (const match of text.matchAll(/\bimport\s+"([^"]+)"/g)) found.push(match[1] as string);
	return found;
}

/**
 * A promise that must settle, raced against a short timer.
 *
 * A run that never ends is a defect of the subject, and the test says so in two
 * seconds rather than in the five the runner would wait.
 */
async function settles<T>(promise: Promise<T>, ms = 2000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`the promise did not settle within ${ms}ms`)),
			ms,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** The provider's answer of one turn. */
function done(stopReason: "stop" | "toolUse"): ProviderEvent {
	return {
		type: "done",
		stopReason,
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
	};
}

/**
 * A provider that answers from a script, one turn at a time.
 *
 * The same shape a real adapter has, which is the point: the core cannot tell the
 * difference between a script and a provider.
 */
function scripted(script: readonly (readonly ProviderEvent[])[]): ProviderFn {
	let turn = 0;
	return async function* provider(_request: ProviderRequest, _signal: AbortSignal) {
		const events = script[turn] ?? [];
		turn += 1;
		for (const event of events) yield event;
	};
}

/** The page's turn: it calls the page's own tool, and then answers. */
const PAGE_TURN: readonly (readonly ProviderEvent[])[] = [
	[
		{ type: "text_delta", delta: "Let me look." },
		{ type: "tool_call_start", id: "c1", name: "echo" },
		{ type: "tool_arguments_delta", id: "c1", delta: '{"text":"hello"}' },
		done("toolUse"),
	],
	[{ type: "text_delta", delta: "It says hello." }, done("stop")],
];

/** The peer's turn: it calls its own tool — never the page's — and then answers. */
const PEER_TURN: readonly (readonly ProviderEvent[])[] = [
	[
		{ type: "tool_call_start", id: "p1", name: "repeat" },
		{ type: "tool_arguments_delta", id: "p1", delta: '{"text":"from the peer"}' },
		done("toolUse"),
	],
	[{ type: "text_delta", delta: "done" }, done("stop")],
];

/** One capability call, as the page's table saw it. */
interface CapabilityCall {
	readonly name: string;
	readonly args: unknown;
}

/** The two halves of the example, wired to each other over an in-memory channel. */
interface Wire {
	readonly page: ReturnType<typeof createPageApp>;
	readonly worker: ReturnType<typeof createWorkerApp>;
	readonly events: readonly AgentEvent[];
	readonly journal: readonly JournalEntry[];
	readonly peerJournal: readonly JournalEntry[];
	readonly notes: readonly string[];
	readonly asked: readonly ApprovalRequest[];
	readonly calls: readonly CapabilityCall[];
	readonly finished: Promise<Outcome>;
	readonly peerFinished: Promise<Outcome>;
}

/**
 * Wires the page and the worker to each other, the way a `Worker` would.
 *
 * The page side is the harness's own worker host — the real one, not a fake of it —
 * and the worker side is the example's own worker application. The provider is
 * injected, so nothing reaches the network.
 */
function wire(options: {
	readonly provider: (apiKey: string) => ProviderFn;
	readonly askHuman: (request: ApprovalRequest) => Promise<HumanDecision>;
	readonly offered?: readonly OfferedTool[];
}): Wire {
	const events: AgentEvent[] = [];
	const journal: JournalEntry[] = [];
	const peerJournal: JournalEntry[] = [];
	const notes: string[] = [];
	const asked: ApprovalRequest[] = [];
	const calls: CapabilityCall[] = [];

	let settleRun: (outcome: Outcome) => void = () => {};
	const finished = new Promise<Outcome>((resolve) => {
		settleRun = resolve;
	});
	let settlePeer: (outcome: Outcome) => void = () => {};
	const peerFinished = new Promise<Outcome>((resolve) => {
		settlePeer = resolve;
	});

	/** The handlers the worker's channel carries. */
	const toWorker: ((message: unknown) => void)[] = [];

	/** The page's own half of the channel. */
	const fake: WorkerLike & { deliver(data: unknown): void } = {
		postMessage(message: unknown) {
			for (const handler of [...toWorker]) handler(message);
		},
		terminate() {
			// The realm never ends in a test.
		},
		onmessage: null,
		deliver(data: unknown) {
			fake.onmessage?.({ data });
		},
	};

	const offered = options.offered ?? catalogue();
	const table: Readonly<Record<string, CapabilityFn>> = capabilities(seedDirectory());
	const watched: Readonly<Record<string, CapabilityFn>> = Object.fromEntries(
		Object.entries(table).map(([name, fn]) => [
			name,
			(args: unknown) => {
				calls.push({ name, args });
				return fn(args);
			},
		]),
	);

	let postToWorker: (frame: unknown) => void = () => {};
	const page = createPageApp({
		catalogue: offered,
		capabilities: watched,
		askHuman: async (request) => {
			asked.push(request);
			return options.askHuman(request);
		},
		post: (frame) => postToWorker(frame),
		onEvent: (event) => {
			events.push(event);
			if (event.type === "agent_end") settleRun(event.outcome);
		},
		onJournal: (entry) => {
			journal.push(entry);
		},
		onPeerJournal: (entry) => {
			peerJournal.push(entry);
		},
		onPeerOutcome: (_taskId, outcome) => settlePeer(outcome),
		onNote: (text) => {
			notes.push(text);
		},
	});

	const host: WorkerHost = createWorkerHost(fake, {
		capabilities: watched,
		onEvent: (event) => {
			events.push(event);
			if (event.type === "agent_end") settleRun(event.outcome);
		},
		onOtherFrame: (frame) => {
			page.handle(frame);
		},
	});
	postToWorker = (frame) => host.channel.post(frame);

	const channel: Channel = {
		post(message) {
			fake.deliver(message);
		},
		onMessage(handler) {
			toWorker.push(handler);
		},
	};
	const worker = createWorkerApp(channel, { provider: options.provider });

	return { page, worker, events, journal, peerJournal, notes, asked, calls, finished, peerFinished };
}

/**
 * A provider factory that answers the page's agent and the peer differently.
 *
 * The two agents are told apart by their system prompt, which is what a host
 * writes anyway: the peer is not the page's agent with another name. Each agent
 * gets its own script — a script that is rebuilt per call would answer every
 * turn with the first one.
 */
function twoAgents(): (apiKey: string) => ProviderFn {
	return () => {
		const pageScript = scripted(PAGE_TURN);
		const peerScript = scripted(PEER_TURN);
		return async function* provider(request: ProviderRequest, signal: AbortSignal) {
			if (request.system.includes("the peer")) {
				yield* peerScript(request, signal);
				return;
			}
			yield* pageScript(request, signal);
		};
	};
}

describe("the example's sources", () => {
	test("every file of the example is there", () => {
		for (const name of SOURCES) {
			expect(existsSync(join(EXAMPLE, name))).toBe(true);
		}
	});

	test("the example reaches the harness only through its public API", () => {
		const files = readdirSync(EXAMPLE).filter(
			(name) => name.endsWith(".ts") || name.endsWith(".mjs"),
		);
		expect(files.length).toBeGreaterThan(0);

		const bare: string[] = [];
		const internal: string[] = [];
		for (const name of files) {
			const file = join(EXAMPLE, name);
			for (const specifier of importsOf(file)) {
				if (specifier.startsWith("node:")) continue;
				if (specifier.startsWith("bun:")) continue;
				if (!specifier.startsWith(".")) {
					// A bare specifier is a dependency, and the example may not add one.
					bare.push(`${name}: ${specifier}`);
					continue;
				}
				const resolved = relative(ROOT, resolve(dirname(file), specifier));
				if (!resolved.startsWith("src/")) continue;
				if (!PUBLIC_API.has(resolved)) internal.push(`${name}: ${resolved}`);
			}
		}
		expect(bare).toEqual([]);
		expect(internal).toEqual([]);
	});

	test("the example declares no dependency of its own", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
			readonly dependencies?: Record<string, string>;
			readonly optionalDependencies?: Record<string, string>;
		};
		expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
		expect(Object.keys(manifest.optionalDependencies ?? {})).toEqual([]);
	});

	test("the key is asked for in the page and never written down", () => {
		const files = readdirSync(EXAMPLE).filter((name) => name.endsWith(".ts"));
		for (const name of files) {
			const text = readFileSync(join(EXAMPLE, name), "utf8");
			// No storage: the key lives in memory, and a key in memory cannot leak
			// into a file the page leaves behind.
			expect(text.includes("localStorage")).toBe(false);
			expect(text.includes("sessionStorage")).toBe(false);
			expect(text.includes("indexedDB")).toBe(false);
			expect(text.includes("document.cookie")).toBe(false);
			// And no key is written into the source either.
			expect(/sk-[A-Za-z0-9_-]{8,}/.test(text)).toBe(false);
		}
		const html = readFileSync(join(EXAMPLE, "index.html"), "utf8");
		expect(html.includes("localStorage")).toBe(false);
		expect(html.includes("sessionStorage")).toBe(false);
		// The page asks for it, and the input that asks is a password field.
		expect(html).toContain('type="password"');
	});

	test("the page's script and the page agree on every element they name", () => {
		const html = readFileSync(join(EXAMPLE, "index.html"), "utf8");
		const entry = readFileSync(join(EXAMPLE, "page.entry.ts"), "utf8");
		const named = [...entry.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1] as string);
		expect(named.length).toBeGreaterThan(0);
		for (const id of named) {
			expect(html).toContain(`id="${id}"`);
		}
	});

	test("the harness is in a worker, and the page is the interface", () => {
		const page = readFileSync(join(EXAMPLE, "page.entry.ts"), "utf8");
		const worker = readFileSync(join(EXAMPLE, "worker.entry.ts"), "utf8");

		// The page starts a worker and talks to it; the worker binds the harness to
		// the worker's own scope. The placement is the architecture's, and it is
		// checked here because nothing else can see it.
		expect(page).toContain("new Worker(");
		expect(page).toContain("worker.js");
		expect(worker).toContain("createWorkerApp");
		expect(worker).toContain("postMessage");
		expect(worker).toContain('addEventListener("message"');
	});

	test("the worker reaches the page's tools through the bridge, not through an import", () => {
		// The page owns the tools. The worker may not import them: a worker that
		// called the page's functions directly would not be using the bridge, and
		// the bridge is the whole of the capability boundary.
		for (const name of ["worker.ts", "worker.entry.ts"]) {
			for (const specifier of importsOf(join(EXAMPLE, name))) {
				expect(`${name}: ${specifier}`).not.toContain("./tools.ts");
			}
		}
	});
});

describe("the bundle, measured in situ", () => {
	test("the example bundles under the ceiling", async () => {
		const out = mkdtempSync(join(tmpdir(), "miha-example-"));
		try {
			const build = Bun.spawn(["sh", join(EXAMPLE, "build.sh"), out], {
				cwd: ROOT,
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await build.exited;
			const output = await new Response(build.stdout).text();
			const errors = await new Response(build.stderr).text();
			expect(`${output}${errors}`).not.toContain("error");
			expect(code).toBe(0);

			const bundles = ["app.js", "worker.js"];
			let total = 0;
			for (const name of bundles) {
				const file = join(out, name);
				expect(existsSync(file)).toBe(true);
				const size = gzipSync(readFileSync(file), { level: 9 }).byteLength;
				total += size;
			}
			// The ceiling is for the whole thing: the page's bundle and the worker's
			// bundle together are what a browser downloads.
			expect(total).toBeLessThan(CEILING);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});
});

describe("the page and the worker agree on the bridge's shape", () => {
	test("the worker accepts every frame the page sends", () => {
		const { worker } = wire({ provider: twoAgents(), askHuman: async () => ({ allow: true }) });
		const frames: readonly (readonly [unknown, (value: unknown) => boolean])[] = [
			[runFrame("hello", "key", catalogue()), isRunFrame],
			[decisionFrame("a1", true), isDecisionFrame],
			[decisionFrame("a2", false, "no"), isDecisionFrame],
			[peerOfferFrame("t1", "a task", "key"), isPeerOfferFrame],
			[cancelFrame(), isCancelFrame],
		];

		for (const [frame, guard] of frames) {
			// The guard and the handler must agree: a frame the module says is ours
			// is a frame the other side takes.
			expect(guard(frame)).toBe(true);
			expect(worker.handle(frame)).toBe(true);
		}
		expect(PAGE_TO_WORKER_KINDS).toEqual(["run", "decision", "peer_offer", "cancel"]);
	});

	test("the page accepts every frame the worker sends", () => {
		const { page } = wire({ provider: twoAgents(), askHuman: async () => ({ allow: true }) });
		const entry: JournalEntry = {
			kind: "message",
			role: "user",
			content: "hello",
			seq: 1,
			version: 1,
		};
		const frames: readonly (readonly [unknown, (value: unknown) => boolean])[] = [
			[approveFrame("a1", "echo", { text: "hi" }), isApproveFrame],
			[journalFrame(entry), isJournalFrame],
			[peerJournalFrame(entry), isPeerJournalFrame],
			[peerOutcomeFrame("t1", { kind: "completed" }), isPeerOutcomeFrame],
			[noteFrame("something happened"), isNoteFrame],
		];

		for (const [frame, guard] of frames) {
			expect(guard(frame)).toBe(true);
			expect(page.handle(frame)).toBe(true);
		}
		expect(WORKER_TO_PAGE_KINDS).toEqual([
			"approve",
			"journal",
			"peer_journal",
			"peer_outcome",
			"note",
		]);
	});

	test("a frame neither side owns is refused, not guessed at", () => {
		const { page, worker } = wire({
			provider: twoAgents(),
			askHuman: async () => ({ allow: true }),
		});
		expect(page.handle({ kind: "not_a_frame" })).toBe(false);
		expect(worker.handle({ kind: "not_a_frame" })).toBe(false);
		expect(page.handle({ kind: "decision" })).toBe(false);
		expect(worker.handle({ kind: "run" })).toBe(false);
		// And the kinds the harness owns are not ours: the bridge answers those.
		expect(page.handle({ kind: "call", id: "c1", capability: "echo", args: null })).toBe(false);
		expect(page.handle({ kind: "answer", id: "c1", ok: true })).toBe(false);
	});
});

describe("the harness runs in the example", () => {
	test("the agent's tools are the page's own, and nothing else", async () => {
		let offered: readonly ToolDefinition[] = [];
		const pageScript = scripted(PAGE_TURN);
		const provider = (): ProviderFn =>
			async function* call(request: ProviderRequest, signal: AbortSignal) {
				offered = request.tools;
				yield* pageScript(request, signal);
			};
		const link = wire({ provider, askHuman: async () => ({ allow: true }) });

		link.page.run("say hello", "test-key");
		const outcome = await settles(link.finished);

		expect(outcome).toEqual({ kind: "completed" });
		expect(offered.map((tool) => tool.name)).toEqual(["read_file", "list_dir", "echo"]);
		expect(catalogue().map((tool) => tool.name)).toEqual(["read_file", "list_dir", "echo"]);
	});

	test("the call reaches the page's capability through the bridge", async () => {
		const link = wire({
			provider: twoAgents(),
			askHuman: async () => ({ allow: true }),
		});

		link.page.run("say hello", "test-key");
		const outcome = await settles(link.finished);

		expect(outcome).toEqual({ kind: "completed" });
		// The tool ran in the page, not in the worker: the worker has no file system
		// and no directory of its own.
		expect(link.calls).toEqual([{ name: "echo", args: { text: "hello" } }]);
		// And the answer came back as a tool result the model could read.
		const result = link.journal.find((entry) => entry.kind === "tool_result");
		expect(result).toBeDefined();
		if (result?.kind !== "tool_result") throw new Error("no tool result");
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	test("the journal reaches the page as it is written", async () => {
		const link = wire({
			provider: twoAgents(),
			askHuman: async () => ({ allow: true }),
		});

		link.page.run("say hello", "test-key");
		await settles(link.finished);

		const kinds = link.journal.map((entry) => entry.kind);
		expect(kinds).toEqual(["message", "message", "tool_call", "tool_result", "message"]);
		// The sequence numbers are the log's own, and they do not skip.
		expect(link.journal.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
	});

	test("a refusal asks the human, and the run continues", async () => {
		const link = wire({
			provider: twoAgents(),
			askHuman: async () => ({ allow: false, reason: "the human said no" }),
		});

		link.page.run("say hello", "test-key");
		const outcome = await settles(link.finished);

		// The human was asked, and the question named the tool.
		expect(link.asked).toHaveLength(1);
		expect(link.asked[0]?.tool).toBe("echo");
		expect(link.asked[0]?.args).toEqual({ text: "hello" });
		// The tool did not run.
		expect(link.calls).toEqual([]);
		// The refusal is in the log, and the run continued past it: the model read
		// the refusal and answered anyway.
		const block = link.journal.find((entry) => entry.kind === "block");
		expect(block).toBeDefined();
		if (block?.kind !== "block") throw new Error("no block entry");
		expect(block.reason).toBe("the human said no");
		expect(outcome).toEqual({ kind: "completed" });
	});

	test("the page refuses to offer a tool it cannot perform", () => {
		const link = wire({
			provider: twoAgents(),
			askHuman: async () => ({ allow: true }),
			offered: [
				{
					name: "not_mine",
					description: "a tool the page cannot perform",
					parameters: { kind: "object", properties: {} },
				},
			],
		});

		const started = link.page.run("say hello", "test-key");

		expect(started).toBe(false);
		expect(link.notes.length).toBeGreaterThan(0);
	});
});

describe("the peer link", () => {
	test("the page offers a task, and the peer runs it with its own tools", async () => {
		let peerTools: readonly ToolDefinition[] = [];
		const pageScript = scripted(PAGE_TURN);
		const peerScript = scripted(PEER_TURN);
		const provider = (): ProviderFn =>
			async function* call(request: ProviderRequest, signal: AbortSignal) {
				if (request.system.includes("the peer")) {
					peerTools = request.tools;
					yield* peerScript(request, signal);
					return;
				}
				yield* pageScript(request, signal);
			};
		const link = wire({ provider, askHuman: async () => ({ allow: true }) });

		// The page's own run first: the worker learns the page's catalogue from it.
		link.page.run("say hello", "test-key");
		await settles(link.finished);

		link.page.offerToPeer("t1", "count to one", "test-key");
		const outcome = await settles(link.peerFinished);

		expect(outcome).toEqual({ kind: "completed" });
		// The peer got a task, not a handle on the page's tools.
		expect(peerTools.map((tool) => tool.name)).toEqual(["repeat"]);
		// And the peer's journal came back to the page.
		expect(link.peerJournal.length).toBeGreaterThan(0);
		expect(link.peerJournal.map((entry) => entry.kind)).toContain("message");
	});
});
