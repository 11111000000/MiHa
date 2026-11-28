#!/usr/bin/env bun
/**
 * Records a live run and replays it.
 *
 * The cassette holds the provider's responses under the hash of the request that
 * asked for them (ADR 0012). Recording a run against the real provider and then
 * replaying it against the cassette must give the same journal — that is the law
 * the cassette exists for, and this is where it is checked against a real run.
 *
 * Usage:
 *   bun scripts/record-run.ts                 # record into test/fixtures/
 *   bun scripts/replay-run.ts                 # replay and compare
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessConfig } from "../src/core/run.ts";
import { toolRegistry } from "../src/core/tools.ts";
import type { JournalEntry } from "../src/core/journal.ts";
import { minimaxProvider, MINIMAX_OPTIONS, MODEL } from "../examples/browser/provider.ts";
import { capabilities, catalogue, seedDirectory } from "../examples/browser/tools.ts";
import { record, replay } from "../src/trace/cassette.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "test", "fixtures", "minimax-run.cassette.json");
/** The journal the live run produced: the golden transcript the replay is checked against. */
const GOLDEN = join(ROOT, "test", "fixtures", "minimax-run.journal.json");

function loadEnv(): void {
	try {
		for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
			const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
			if (match === null) continue;
			const name = match[1];
			const value = match[2]?.replace(/^["']|["']$/g, "") ?? "";
			if (name !== undefined && value !== "" && process.env[name] === undefined) {
				process.env[name] = value;
			}
		}
	} catch {
		// no .env: the environment has what it needs
	}
}

loadEnv();

const TASK = "read notes.txt, list the directory, and tell me what the harness is";

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function buildConfig(): HarnessConfig {
	return {
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
					const value = await capabilities(seedDirectory())[offered.name]?.(args);
					return { content: [{ type: "text", text: textOf(value) }] };
				},
			})),
		),
		turnLimit: 32,
	};
}

async function run(provider: HarnessHost["callProvider"]): Promise<readonly JournalEntry[]> {
	const journal: JournalEntry[] = [];
	const host: HarnessHost = {
		callProvider: provider,
		append: (entry: JournalEntry) => {
			journal.push(entry);
		},
	};
	const run = runAgent(buildConfig(), host, { message: { role: "user", content: TASK } });
	for await (const _event of run) {
		// drain
	}
	const outcome = await run.result();
	if (outcome.kind !== "completed") {
		throw new Error(`the run ended ${outcome.kind}: ${JSON.stringify(outcome)}`);
	}
	return journal;
}

type HarnessHost = Parameters<typeof runAgent>[1];

async function recordRun(): Promise<void> {
	const key = process.env["MINIMAX_API_KEY"];
	if (key === undefined || key.length === 0) {
		console.log("no MINIMAX_API_KEY: put it in .env at the repository's root");
		process.exit(1);
	}
	const recorder = record(minimaxProvider(key));
	const journal = await run(recorder.callProvider);
	const cassette = recorder.cassette;
	writeFileSync(FIXTURE, `${JSON.stringify(cassette, null, 2)}\n`);
	writeFileSync(GOLDEN, `${JSON.stringify(journal, null, 2)}\n`);
	console.log(`recorded ${journal.length} entries and ${Object.keys(cassette.responses).length} responses`);
	console.log(`written to ${FIXTURE} and ${GOLDEN}`);
}

async function replayRun(): Promise<void> {
	const cassette = JSON.parse(readFileSync(FIXTURE, "utf8")) as Parameters<typeof replay>[0];
	const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as readonly JournalEntry[];
	const replayed = replay(cassette);
	const journal = await run(replayed.callProvider);

	if (replayed.divergences.length > 0) {
		console.log(`the replay diverged ${replayed.divergences.length} times`);
		for (const divergence of replayed.divergences) {
			console.log(`  ${divergence.key}: ${divergence.reason}`);
		}
		process.exit(1);
	}

	// The law: a recorded run replays to the same transcript, entry by entry.
	if (journal.length !== golden.length) {
		console.log(`the replay has ${journal.length} entries, the recording has ${golden.length}`);
		process.exit(1);
	}
	for (let index = 0; index < golden.length; index += 1) {
		const expected = golden[index];
		const actual = journal[index];
		if (JSON.stringify(expected) !== JSON.stringify(actual)) {
			console.log(`the first difference is at entry ${index}:`);
			console.log(`  recorded: ${JSON.stringify(expected)}`);
			console.log(`  replayed: ${JSON.stringify(actual)}`);
			process.exit(1);
		}
	}
	console.log(`the replay reproduces the recording exactly: ${journal.length} entries, no divergence`);
}

if (process.argv[2] === "replay") {
	await replayRun();
} else {
	await recordRun();
}
