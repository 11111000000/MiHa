import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import type { ProviderEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import { userMessage } from "../src/core/messages.ts";
import type { JournalEntry } from "../src/core/journal.ts";

/**
 * The host's better digest (ADR 0010 D56): when the core collapses a range, the
 * driver asks the host for a summary and applies a change — the journal keeps both,
 * and the model reads the host's.
 */

function config(over: Partial<HarnessConfig> = {}): HarnessConfig {
	return { model: "test-model", system: "you are a test", tools: toolRegistry([]), turnLimit: 20, ...over };
}

const echo: ToolDefinition = {
	name: "echo",
	description: "echoes",
	parameters: { kind: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
};

function provider(): HarnessHost["callProvider"] {
	let turn = 0;
	return async function* (_request: ProviderRequest) {
		turn += 1;
		if (turn > 16) {
			yield {
				type: "done",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			} as ProviderEvent;
			return;
		}
		yield { type: "tool_call_start", id: `c${turn}`, name: "echo" } as ProviderEvent;
		yield { type: "tool_arguments_delta", id: `c${turn}`, delta: "{}" } as ProviderEvent;
		yield {
			type: "done",
			stopReason: "toolUse",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		} as ProviderEvent;
	};
}


/** The text of a message, whether it is a string or a list of blocks. */
function textOf(message: { readonly content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((block) =>
			typeof block === "object" && block !== null && "text" in block
				? String((block as { readonly text: unknown }).text)
				: "",
		)
		.join("");
}

async function collect(run: ReturnType<typeof runAgent>) {
	const events = [];
	for await (const event of run) events.push(event);
	return { events, outcome: await run.result() };
}

describe("the host's digest", () => {
	test("the host's summary reaches the model, and the journal keeps both", async () => {
		const entries: JournalEntry[] = [];
		const run = runAgent(
			config({ tools: toolRegistry([echo]), contextBudget: 100 }),
			{
				callProvider: provider(),
				append: (entry) => entries.push(entry),
				summarize: async () => "the host's own words",
			},
			{ message: userMessage("go") },
		);
		const { events } = await collect(run);

		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const digests = end.messages.filter(
			(message) => message.role === "user" && textOf(message).startsWith("[compacted]"),
		);
		expect(digests.length).toBeGreaterThan(0);
		expect(textOf(digests[0] ?? { content: "" })).toContain("the host's own words");

		// The journal keeps the compaction and the change that replaced its summary.
		expect(entries.filter((entry) => entry.kind === "compaction").length).toBeGreaterThan(0);
		expect(entries.filter((entry) => entry.kind === "change").length).toBeGreaterThan(0);
	});

	test("without a summarizer the mechanical digest stays", async () => {
		const entries: JournalEntry[] = [];
		const run = runAgent(
			config({ tools: toolRegistry([echo]), contextBudget: 100 }),
			{ callProvider: provider(), append: (entry) => entries.push(entry) },
			{ message: userMessage("go") },
		);
		const { events } = await collect(run);

		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const digests = end.messages.filter(
			(message) => message.role === "user" && textOf(message).startsWith("[compacted]"),
		);
		expect(digests.length).toBeGreaterThan(0);
		expect(textOf(digests[0] ?? { content: "" })).toContain("entries collapsed");
		expect(entries.filter((entry) => entry.kind === "change")).toHaveLength(0);
	});

	test("a summarizer that fails leaves the digest exactly as it was", async () => {
		const entries: JournalEntry[] = [];
		const run = runAgent(
			config({ tools: toolRegistry([echo]), contextBudget: 100 }),
			{
				callProvider: provider(),
				append: (entry) => entries.push(entry),
				summarize: async () => {
					throw new Error("the host's model is down");
				},
			},
			{ message: userMessage("go") },
		);
		const { events, outcome } = await collect(run);

		expect(outcome).toEqual({ kind: "completed" });
		const end = events.find((event) => event.type === "agent_end");
		if (!end || end.type !== "agent_end") throw new Error("no agent_end");
		const digests = end.messages.filter(
			(message) => message.role === "user" && textOf(message).startsWith("[compacted]"),
		);
		expect(textOf(digests[0] ?? { content: "" })).toContain("entries collapsed");
		expect(entries.filter((entry) => entry.kind === "change")).toHaveLength(0);
	});

	test("a summarizer that says nothing leaves the digest exactly as it was", async () => {
		const entries: JournalEntry[] = [];
		const run = runAgent(
			config({ tools: toolRegistry([echo]), contextBudget: 100 }),
			{
				callProvider: provider(),
				append: (entry) => entries.push(entry),
				summarize: async () => "",
			},
			{ message: userMessage("go") },
		);
		await collect(run);
		expect(entries.filter((entry) => entry.kind === "change")).toHaveLength(0);
	});
});
