/**
 * The cassette replays the run it recorded.
 *
 * The fixture is a real run: the provider's own responses, recorded against
 * MiniMax-M3's cheaper sibling, and the journal that run produced. Replaying it
 * against the cassette must reproduce the journal entry by entry — the law the
 * cassette exists for (ADR 0012), checked without a network.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessConfig } from "../src/core/run.ts";
import { toolRegistry } from "../src/core/tools.ts";
import type { JournalEntry } from "../src/core/journal.ts";
import { MODEL } from "../examples/browser/provider.ts";
import { capabilities, catalogue, seedDirectory } from "../examples/browser/tools.ts";
import { replay, type Cassette } from "../src/trace/cassette.ts";

const ROOT = join(import.meta.dir, "..");
const CASSETTE = join(ROOT, "test", "fixtures", "minimax-run.cassette.json");
const GOLDEN = join(ROOT, "test", "fixtures", "minimax-run.journal.json");

const TASK = "read notes.txt, list the directory, and tell me what the harness is";

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function config(): HarnessConfig {
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

describe("the recorded run", () => {
	test("the cassette replays the journal it was recorded with", async () => {
		const cassette = JSON.parse(readFileSync(CASSETTE, "utf8")) as Cassette;
		const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as readonly JournalEntry[];

		const replayed = replay(cassette);
		const journal: JournalEntry[] = [];
		const run = runAgent(
			config(),
			{
				callProvider: replayed.callProvider,
				append: (entry: JournalEntry) => {
					journal.push(entry);
				},
			},
			{ message: { role: "user", content: TASK } },
		);
		for await (const _event of run) {
			// drain
		}
		const outcome = await run.result();

		expect(outcome).toEqual({ kind: "completed" });
		expect(replayed.divergences).toEqual([]);
		expect(journal.length).toBe(golden.length);
		for (let index = 0; index < golden.length; index += 1) {
			expect(journal[index]).toEqual(golden[index]);
		}
	});

	test("the cassette holds the provider's responses and nothing else", () => {
		const cassette = JSON.parse(readFileSync(CASSETTE, "utf8")) as Cassette;
		const json = JSON.stringify(cassette);
		expect(json).not.toContain("read notes.txt, list the directory");
		expect(json).not.toContain("you are the agent of a browser application");
		expect(Object.keys(cassette.responses).length).toBeGreaterThan(0);
	});
});
