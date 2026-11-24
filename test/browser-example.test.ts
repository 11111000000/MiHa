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
 *   API** — the barrels, and nothing below them, in every form an import
 *   takes, and in the document's own scripts;
 * - the files the browser loads ask for nothing the browser cannot load, and the
 *   page's own tools stay the page's — the worker reaches them through the
 *   bridge, never through an import, whatever spelling the import wears;
 * - the key is asked for in the page and is written down nowhere: no storage, no
 *   cookie, and no key in any file of the example, whatever the file is;
 * - the page names only elements the document has, and it loads only scripts the
 *   ceiling measures;
 * - the build produces bundles whose gzipped size is under the ceiling — the number
 *   the budget check enforces, measured on the example rather than on a synthetic
 *   entry that re-exports the barrels;
 * - the page and the worker **agree on the bridge's shape**: every frame one side
 *   sends, the other side accepts;
 * - and the whole round trip runs — the agent's tools are the page's own, a call
 *   reaches the page's capability through the bridge, a refusal asks the human and
 *   the run continues, a question the human cannot answer is refused anyway, and
 *   the journal reaches the page as it is written.
 *
 * The provider answers from a script instead of from a network: the evidence copy
 * has no key and no socket, and a live provider is not a verifier.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
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

/**
 * The bundles the ceiling measures: the page's script and the worker's script.
 *
 * They are what a browser downloads, so they are what the ceiling is about. A
 * script the page loads that is not one of them is not measured — and the
 * ceiling would then be a number about something the browser never fetched.
 */
const BUNDLES = ["app.js", "worker.js"] as const;

/**
 * What a key in a file looks like.
 *
 * The key lives in memory and nowhere else: no storage, no cookie, and no key
 * written into a source. The patterns are the four ways a key leaves memory,
 * and the shape a provider's key has.
 */
const KEY_PATTERNS = [
	/localStorage/,
	/sessionStorage/,
	/indexedDB/,
	/document\s*\.\s*cookie/,
	/document\s*\[\s*["']cookie["']\s*\]/,
	/sk-[A-Za-z0-9_-]{8,}/,
] as const;

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

/**
 * The forms an import takes, and the specifier each one carries.
 *
 * A static import, a bare import, a dynamic import and a `require` are four
 * spellings of one thing. A scan that misses one of them is a scan with a hole
 * in it: a module reached dynamically is reached, and a module reached that way
 * is just as much a part of the example as one reached by a declaration.
 *
 * A template literal counts as a spelling too — `import(`./tools.js`)` reaches
 * the same file as `import("./tools.js")` does.
 */
const IMPORT_FORMS = [
	/\bfrom\s+["'`]([^"'`]+)["'`]/g,
	/\bimport\s+["'`]([^"'`]+)["'`]/g,
	/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
	/\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
] as const;

/** The import specifiers of one source, in the order the source names them. */
function specifiersOf(text: string): readonly string[] {
	const found: { readonly at: number; readonly specifier: string }[] = [];
	for (const form of IMPORT_FORMS) {
		for (const match of text.matchAll(form)) {
			found.push({ at: match.index ?? 0, specifier: match[1] as string });
		}
	}
	return found
		.sort((left, right) => left.at - right.at)
		.map((entry) => entry.specifier);
}

/** The import specifiers of one file. */
function importsOf(file: string): readonly string[] {
	return specifiersOf(readFileSync(file, "utf8"));
}

/**
 * The file a relative specifier names, if the tree has it.
 *
 * A `.js` specifier may name a `.ts` file: that is the TypeScript convention,
 * and the one a bundler follows. The resolution says which file is meant — the
 * spelling says nothing, and a rule written against a spelling is a rule that
 * one more spelling walks around.
 */
function resolveSpecifier(from: string, specifier: string): string | undefined {
	const base = resolve(dirname(from), specifier);
	const candidates: string[] = [base];
	for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
		candidates.push(`${base}${extension}`);
	}
	for (const extension of [".js", ".mjs", ".cjs"]) {
		if (base.endsWith(extension)) {
			candidates.push(`${base.slice(0, -extension.length)}.ts`);
		}
	}
	candidates.push(join(base, "index.ts"), join(base, "index.js"));
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

/**
 * The files the browser loads: the two bundle entries and everything they reach.
 *
 * The bundle's entries are the page's script and the worker's script, and the
 * files they import are theirs. A file nothing reaches — the example's own
 * measurement script, its own test — is the toolchain's business and not the
 * browser's, and a rule about the browser must not become a rule about the
 * tools that build it.
 */
function browserFiles(): readonly string[] {
	const seen = new Set<string>();
	const walk = (file: string): void => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const specifier of importsOf(file)) {
			if (!specifier.startsWith(".")) continue;
			const target = resolveSpecifier(file, specifier);
			if (target !== undefined) walk(target);
		}
	};
	walk(join(EXAMPLE, "page.entry.ts"));
	walk(join(EXAMPLE, "worker.entry.ts"));
	return [...seen];
}

/** Every file under a directory, by path. */
function everyFileOf(dir: string): readonly string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...everyFileOf(full));
		else found.push(full);
	}
	return found;
}

/**
 * The scripts the document loads.
 *
 * A `<script src>` is one, and so is a module the document asks the browser to
 * fetch ahead of time: the browser downloads it either way, and a file nobody
 * measured is a file nobody counted.
 */
function scriptsOf(html: string): readonly string[] {
	const found: string[] = [];
	for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)) {
		found.push(match[1] as string);
	}
	for (const match of html.matchAll(/<link\b[^>]*\brel\s*=\s*["']modulepreload["'][^>]*>/g)) {
		const href = /\bhref\s*=\s*["']([^"']+)["']/.exec(match[0] as string);
		if (href) found.push(href[1] as string);
	}
	return found;
}

/**
 * The scripts written into the document, as the document writes them.
 *
 * The prose of a page is not code, and a scan that read it would read a
 * sentence as a declaration. The scripts are the code.
 */
function inlineScriptsOf(html: string): readonly string[] {
	const found: string[] = [];
	for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
		if (/\bsrc\s*=/.test(match[1] as string)) continue;
		found.push(match[2] as string);
	}
	return found;
}

/** The scripts the page starts as a worker. */
function workerScriptsOf(text: string): readonly string[] {
	const found: string[] = [];
	for (const match of text.matchAll(/new\s+Worker\s*\(\s*["']([^"']+)["']/g)) {
		found.push(match[1] as string);
	}
	return found;
}

/**
 * The ids the page names, in every form it may name one.
 *
 * `byId` is the page's own helper, `getElementById` is the document's, and
 * `querySelector("#x")` is the same id written as a selector. A page that names
 * an element the document does not have is a page that throws on the first
 * click.
 */
function idsOf(text: string): readonly string[] {
	const found: string[] = [];
	for (const match of text.matchAll(/\bbyId\(\s*["']([^"']+)["']\s*\)/g)) {
		found.push(match[1] as string);
	}
	for (const match of text.matchAll(/\bgetElementById\(\s*["']([^"']+)["']\s*\)/g)) {
		found.push(match[1] as string);
	}
	for (const match of text.matchAll(/\bquerySelector(?:All)?\(\s*["']#([^"']+)["']/g)) {
		found.push(match[1] as string);
	}
	return found;
}

/** The ids the document has. */
function idsIn(html: string): readonly string[] {
	const found: string[] = [];
	for (const match of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) {
		found.push(match[1] as string);
	}
	return found;
}

/**
 * Whether a specifier names the page's tools, whatever spelling it uses.
 *
 * The worker may not import the page's tools: the page owns them, and a worker
 * that called them directly would not be using the bridge. The rule is about
 * the module, and a rule about the module is not a rule about the way the
 * module happens to be written down.
 */
function namesTools(specifier: string): boolean {
	const segment = specifier.split("/").pop() ?? "";
	return segment.replace(/\.[^.]+$/, "") === "tools";
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

/**
 * One thing the page saw, in the order it saw it.
 *
 * The page's callbacks are the only witness to the order: the journal's
 * contents say what arrived, and this says when. A journal that was buffered
 * and flushed at the end has the same contents and a different order, and the
 * difference is the whole of "as it is written".
 */
interface Step {
	readonly kind: "journal" | "peer_journal" | "event" | "note";
	/** The event's own type, when the step is an event. */
	readonly type?: string;
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
	readonly steps: readonly Step[];
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
	const steps: Step[] = [];

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
			steps.push({ kind: "journal" });
		},
		onPeerJournal: (entry) => {
			peerJournal.push(entry);
			steps.push({ kind: "peer_journal" });
		},
		onPeerOutcome: (_taskId, outcome) => settlePeer(outcome),
		onNote: (text) => {
			notes.push(text);
			steps.push({ kind: "note" });
		},
	});

	const host: WorkerHost = createWorkerHost(fake, {
		capabilities: watched,
		onEvent: (event) => {
			events.push(event);
			steps.push({ kind: "event", type: event.type });
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

	return {
		page,
		worker,
		events,
		journal,
		peerJournal,
		notes,
		asked,
		calls,
		steps,
		finished,
		peerFinished,
	};
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

	test("the import scan sees every form of an import", () => {
		// A scan that reads one spelling is a scan with a hole in it: a module
		// reached dynamically is reached, and a module reached that way is just as
		// much a part of the example as one reached by a declaration.
		const text = [
			'import { one } from "./one.ts";',
			'import "./two.ts";',
			'const three = await import("./three.ts");',
			'const four = require("./four.ts");',
		].join("\n");
		expect(specifiersOf(text)).toEqual(["./one.ts", "./two.ts", "./three.ts", "./four.ts"]);
	});

	test("the example reaches the harness only through its public API", () => {
		const files = readdirSync(EXAMPLE).filter(
			(name) => name.endsWith(".ts") || name.endsWith(".mjs"),
		);
		expect(files.length).toBeGreaterThan(0);

		// The document is one of the example's sources too: a script written into
		// the page is a script the page runs, and it may not reach into the
		// harness's internals either.
		const sources: readonly (readonly [string, string])[] = [
			...files.map(
				(name): readonly [string, string] => [name, readFileSync(join(EXAMPLE, name), "utf8")],
			),
			...inlineScriptsOf(readFileSync(join(EXAMPLE, "index.html"), "utf8")).map(
				(text): readonly [string, string] => ["index.html", text],
			),
		];

		const bare: string[] = [];
		const internal: string[] = [];
		for (const [name, text] of sources) {
			const file = join(EXAMPLE, name);
			for (const specifier of specifiersOf(text)) {
				if (specifier.startsWith("node:")) continue;
				if (specifier.startsWith("bun:")) continue;
				if (!specifier.startsWith(".")) {
					// A bare specifier is a dependency, and the example may not add one.
					bare.push(`${name}: ${specifier}`);
					continue;
				}
				// The file the specifier names, when the tree has it; the path it
				// spells out when it does not. Either way, the module is named.
				const target = resolveSpecifier(file, specifier) ?? resolve(dirname(file), specifier);
				const resolved = relative(ROOT, target);
				if (!resolved.startsWith("src/")) continue;
				if (!PUBLIC_API.has(resolved)) internal.push(`${name}: ${resolved}`);
			}
		}
		expect(bare).toEqual([]);
		expect(internal).toEqual([]);
	});

	test("the files the browser reaches ask for nothing the browser cannot load", () => {
		// `node:` and `bun:` do not resolve in a browser. The toolchain's own
		// files may use them — the measurement script is run by node — but a file
		// the browser loads may not, and the difference is the difference between
		// the toolchain and the realm.
		const offenders: string[] = [];
		for (const file of browserFiles()) {
			for (const specifier of importsOf(file)) {
				if (!specifier.startsWith("node:") && !specifier.startsWith("bun:")) continue;
				offenders.push(`${relative(ROOT, file)}: ${specifier}`);
			}
		}
		expect(offenders).toEqual([]);
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
		// Every file of the example, every extension. A key written into a script
		// the page never loads is still a key in the example, and a key written
		// into a file of another kind is no less a key for being harder to see.
		const offenders: string[] = [];
		for (const file of everyFileOf(EXAMPLE)) {
			const text = readFileSync(file, "utf8");
			for (const pattern of KEY_PATTERNS) {
				// No storage: the key lives in memory, and a key in memory cannot
				// leak into a file the page leaves behind. And no key is written
				// into a source either.
				if (pattern.test(text)) offenders.push(`${relative(ROOT, file)}: ${pattern.source}`);
			}
		}
		expect(offenders).toEqual([]);
		// The page asks for it, and the input that asks is a password field.
		const html = readFileSync(join(EXAMPLE, "index.html"), "utf8");
		expect(html).toContain('type="password"');
	});

	test("the page's script and the page agree on every element they name", () => {
		const html = readFileSync(join(EXAMPLE, "index.html"), "utf8");
		const have = idsIn(html);
		const named: string[] = [];
		for (const file of browserFiles()) {
			for (const id of idsOf(readFileSync(file, "utf8"))) named.push(id);
		}
		expect(named.length).toBeGreaterThan(0);
		const missing = named.filter((id) => !have.includes(id));
		expect(missing).toEqual([]);
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
		//
		// The rule is about the module and not about the way it is written down:
		// `./tools.ts` and `./tools.js` are the same file, and a rule that names
		// one of them is a rule that the other one walks around.
		const offenders: string[] = [];
		for (const name of ["worker.ts", "worker.entry.ts"]) {
			const file = join(EXAMPLE, name);
			for (const specifier of importsOf(file)) {
				if (!specifier.startsWith(".")) continue;
				const target = resolveSpecifier(file, specifier);
				const named = target === undefined ? specifier : relative(ROOT, target);
				if (named === relative(ROOT, join(EXAMPLE, "tools.ts")) || namesTools(specifier)) {
					offenders.push(`${name}: ${specifier}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("the bundle, measured in situ", () => {
	test("every script the page loads is one of the bundles the ceiling measures", () => {
		// The ceiling is on what a browser downloads. A script the page loads that
		// the ceiling does not measure is a script the ceiling knows nothing
		// about, and a number about something else would be reported as a number
		// about this.
		const html = readFileSync(join(EXAMPLE, "index.html"), "utf8");
		const entry = readFileSync(join(EXAMPLE, "page.entry.ts"), "utf8");
		const loaded = [...scriptsOf(html), ...workerScriptsOf(entry)];
		expect(loaded.length).toBeGreaterThan(0);
		const measured = BUNDLES as readonly string[];
		for (const src of loaded) {
			expect(measured).toContain(basename(src));
		}
	});

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

			let total = 0;
			for (const name of BUNDLES) {
				const file = join(out, name);
				expect(existsSync(file)).toBe(true);
				const size = gzipSync(readFileSync(file), { level: 9 }).byteLength;
				total += size;
			}
			// The ceiling is for the whole thing: the page's bundle and the worker's
			// bundle together are what a browser downloads.
			expect(total).toBeLessThan(CEILING);

			// And the page loads what the build produced: a document that names a
			// script the build did not make is a page that fetches nothing.
			const html = readFileSync(join(EXAMPLE, "index.html"), "utf8");
			const entry = readFileSync(join(EXAMPLE, "page.entry.ts"), "utf8");
			for (const src of [...scriptsOf(html), ...workerScriptsOf(entry)]) {
				const path = src.startsWith("./") ? src.slice(2) : src;
				expect(existsSync(join(out, path))).toBe(true);
			}
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

		// The contents are not the whole of it. A journal that was buffered and
		// flushed at the end has the same contents and is not the same thing: the
		// last entry has to be at the page before the run says it is over, or the
		// page is reading a transcript of a run that had already finished.
		const lastJournal = link.steps.reduce(
			(last, step, index) => (step.kind === "journal" ? index : last),
			-1,
		);
		const ended = link.steps.findIndex(
			(step) => step.kind === "event" && step.type === "agent_end",
		);
		expect(lastJournal).toBeGreaterThanOrEqual(0);
		expect(ended).toBeGreaterThanOrEqual(0);
		expect(lastJournal).toBeLessThan(ended);
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

	test("a question the human cannot answer is refused, and the run ends", async () => {
		const link = wire({
			provider: twoAgents(),
			// The question could not be asked: the dialog is broken, the tab is
			// closing, the person is not there. The run must not wait for an
			// answer that will never come.
			askHuman: async () => {
				throw new Error("the dialog is broken");
			},
		});

		link.page.run("say hello", "test-key");
		const outcome = await settles(link.finished);

		// The question was asked, and it could not be answered.
		expect(link.asked).toHaveLength(1);
		expect(link.asked[0]?.tool).toBe("echo");
		// The call did not run.
		expect(link.calls).toEqual([]);
		// And the refusal is in the journal: the model read why the call did not
		// happen, and the run continued past it.
		const block = link.journal.find((entry) => entry.kind === "block");
		expect(block).toBeDefined();
		if (block?.kind !== "block") throw new Error("no block entry");
		expect(block.reason).toContain("the question could not be asked");
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
