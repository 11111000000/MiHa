import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import type { ProviderEvent } from "../src/core/events.ts";
import { userMessage } from "../src/core/messages.ts";

/**
 * The peer layer is optional and the core stands alone (ADR 0020 D106).
 *
 * The exchange is a layer the host may add — or leave out. Nothing under
 * `src/core/` may import it, and a run must complete with no peer installed:
 * the harness stands in the page by itself, and delegation is somebody else's
 * addition.
 */

const CORE = join(import.meta.dir, "..", "src", "core");

/** Every file under src/core, recursively. */
function coreFiles(dir: string = CORE, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) coreFiles(full, out);
		else if (name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** The import specifiers a file reaches through. */
function specifiersOf(source: string): string[] {
	const found: string[] = [];
	const patterns = [
		/from\s+"([^"]+)"/g,
		/from\s+'([^']+)'/g,
		/\bimport\s+"([^"]+)"/g,
		/\bimport\s*\(\s*"([^"]+)"\s*\)/g,
	];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(source)) !== null) found.push(match[1] ?? "");
	}
	return found;
}

describe("the peer layer is optional (ADR 0020 D106)", () => {
	test("no file under src/core imports the exchange", () => {
		const offenders: string[] = [];
		for (const file of coreFiles()) {
			const source = readFileSync(file, "utf8");
			for (const specifier of specifiersOf(source)) {
				if (specifier.includes("exchange")) offenders.push(`${file} → ${specifier}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("a run completes with no peer installed and no exchange in sight", async () => {
		const done: ToolDefinition = {
			name: "echo",
			description: "echoes",
			parameters: { kind: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		};
		const config: HarnessConfig = {
			model: "test-model",
			system: "you are a test",
			tools: toolRegistry([done]),
			turnLimit: 8,
		};
		const host: HarnessHost = {
			callProvider: async function* (_request: ProviderRequest) {
				yield { type: "text_delta", delta: "the run stands alone" } as ProviderEvent;
				yield {
					type: "done",
					stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
				} as ProviderEvent;
			},
		};
		const run = runAgent(config, host, { message: userMessage("go") });
		const events = [];
		for await (const event of run) events.push(event);
		const outcome = await run.result();

		expect(outcome).toEqual({ kind: "completed" });
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
	});
});

import { toolRegistry } from "../src/core/tools.ts";
import type { ToolDefinition } from "../src/core/tools.ts";
