#!/usr/bin/env bun
/**
 * The measurement: a hundred real tasks against the real provider.
 *
 * The defaults of the harness — the result budget, the turn limit, the context
 * budget, the window — were derived from other people's measurements. This runs
 * the harness over a hundred tasks of our own and says what they actually cost.
 *
 * Usage: bun scripts/measure-tasks.ts [--concurrency N] [--out FILE]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import { toolRegistry } from "../src/core/tools.ts";
import type { JournalEntry } from "../src/core/journal.ts";
import { minimaxProvider, MINIMAX_OPTIONS, MODEL } from "../examples/browser/provider.ts";
import { capabilities, catalogue, seedDirectory } from "../examples/browser/tools.ts";

const ROOT = join(import.meta.dir, "..");

/** The repo-local secrets: the provider's key. */
function loadEnv(): void {
	const path = join(ROOT, ".env");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return;
	}
	for (const line of text.split("\n")) {
		const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (match === null) continue;
		const name = match[1];
		const value = match[2]?.replace(/^["']|["']$/g, "") ?? "";
		if (name !== undefined && value !== "" && process.env[name] === undefined) {
			process.env[name] = value;
		}
	}
}

loadEnv();

const args = process.argv.slice(2);
function argOf(flag: string, fallback: number): number {
	const index = args.indexOf(flag);
	if (index === -1) return fallback;
	const value = Number(args[index + 1]);
	return Number.isFinite(value) ? value : fallback;
}

const concurrency = argOf("--concurrency", 6);
const outPath = argOf("--out", 0) === 0 ? join(ROOT, "docs/research/06-measurements.json") : String(args[args.indexOf("--out") + 1]);

const key = process.env["MINIMAX_API_KEY"] ?? "";
if (key.length === 0) {
	console.log("no MINIMAX_API_KEY: put it in .env at the repository's root");
	process.exit(1);
}

const tasks = readFileSync(join(ROOT, "scripts", "tasks.txt"), "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.length > 0 && !line.startsWith("#"));

/** The text of a capability's answer, as the worker would put it into the context. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

interface Measurement {
	readonly task: string;
	readonly outcome: string;
	/** The provider requests the run made. */
	readonly requests: number;
	/** The turns the run took (the requests after the first). */
	readonly turns: number;
	/** The journal's entries. */
	readonly entries: number;
	/** The size of the folded context in bytes, at the end of the run. */
	readonly contextBytes: number;
	/** The largest single tool result, in bytes. */
	readonly biggestResult: number;
	/** The compactions the run needed. */
	readonly compactions: number;
	/** The tokens the provider reported, in and out. */
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly milliseconds: number;
}

async function measure(task: string): Promise<Measurement> {
	const directory = seedDirectory();
	const table = capabilities(directory);
	const journal: JournalEntry[] = [];
	let requests = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	const started = Date.now();

	const config: HarnessConfig = {
		model: MODEL,
		system:
			"you are the agent of a browser application. the application owns the files you may read, " +
			"and every call you make is shown to the person who uses it before it runs.",
		tools: toolRegistry(
			catalogue().map((offered) => ({
				name: offered.name,
				description: offered.description,
				parameters: offered.parameters,
				execute: async (_call: unknown, args: unknown) => {
					// The real capability: the tool's answer is what a real run
					// would put into the context.
					const capability = table[offered.name];
					const value = capability === undefined ? undefined : await capability(args);
					return { content: [{ type: "text", text: textOf(value) }] };
				},
			})),
		),
		turnLimit: 64,
	};

	const provider = minimaxProvider(key);
	const host = {
		callProvider: async function* (request: ProviderRequest, signal: AbortSignal) {
			requests += 1;
			for await (const event of provider(request, signal)) {
				if (event.type === "done") {
					inputTokens += event.usage.input;
					outputTokens += event.usage.output;
				}
				yield event;
			}
		},
		append: (entry: JournalEntry) => {
			journal.push(entry);
		},
	};

	const run = runAgent(config, host, {
		message: { role: "user", content: task },
	});
	for await (const _event of run) {
		// drain
	}
	const outcome = await run.result();

	const results = journal.filter((entry) => entry.kind === "tool_result");
	const biggest = results.reduce(
		(size, entry) =>
			entry.kind === "tool_result"
				? Math.max(size, JSON.stringify(entry.content).length)
				: size,
		0,
	);

	return {
		task,
		outcome: outcome.kind,
		requests,
		turns: Math.max(0, requests - 1),
		entries: journal.length,
		contextBytes: JSON.stringify(journal).length,
		biggestResult: biggest,
		compactions: journal.filter((entry) => entry.kind === "compaction").length,
		inputTokens,
		outputTokens,
		milliseconds: Date.now() - started,
	};
}

/** The percentile of a sorted list. */
function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[index] ?? 0;
}

const measurements: Measurement[] = [];
let cursor = 0;

async function worker(): Promise<void> {
	for (;;) {
		const index = cursor;
		cursor += 1;
		const task = tasks[index];
		if (task === undefined) return;
		const measurement = await measure(task);
		measurements.push(measurement);
		process.stdout.write(`\r${measurements.length}/${tasks.length} measured   `);
	}
}

console.log(`measuring ${tasks.length} tasks against ${MODEL}, ${concurrency} at a time`);
const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(`\ndone in ${Math.round((Date.now() - started) / 1000)}s`);

const turns = measurements.map((m) => m.turns);
const contexts = measurements.map((m) => m.contextBytes);
const results = measurements.map((m) => m.biggestResult);
const requests = measurements.map((m) => m.requests);
const input = measurements.map((m) => m.inputTokens);
const output = measurements.map((m) => m.outputTokens);
const times = measurements.map((m) => m.milliseconds);

const summary = {
	model: MODEL,
	tasks: measurements.length,
	completed: measurements.filter((m) => m.outcome === "completed").length,
	turns: {
		median: percentile(turns, 50),
		p90: percentile(turns, 90),
		max: Math.max(...turns),
	},
	requests: { median: percentile(requests, 50), max: Math.max(...requests) },
	contextBytes: { median: percentile(contexts, 50), p90: percentile(contexts, 90), max: Math.max(...contexts) },
	resultBytes: { median: percentile(results, 50), p90: percentile(results, 90), max: Math.max(...results) },
	compactions: measurements.reduce((sum, m) => sum + m.compactions, 0),
	tokens: {
		inputMedian: percentile(input, 50),
		inputMax: Math.max(...input),
		outputMedian: percentile(output, 50),
		outputMax: Math.max(...output),
	},
	milliseconds: { median: percentile(times, 50), p90: percentile(times, 90) },
};

console.log(JSON.stringify(summary, null, 2));
writeFileSync(outPath, `${JSON.stringify({ summary, measurements }, null, 2)}\n`);
console.log(`written to ${outPath}`);
