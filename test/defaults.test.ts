import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/core/loop.ts";
import type { HarnessHost } from "../src/core/loop.ts";
import type { HarnessConfig, ProviderRequest } from "../src/core/run.ts";
import { DEFAULT_TURN_LIMIT } from "../src/core/run.ts";
import type { ProviderEvent } from "../src/core/events.ts";
import { toolRegistry, type ToolDefinition } from "../src/core/tools.ts";
import { userMessage } from "../src/core/messages.ts";

/**
 * The turn limit's default (ADR 0009 D51): a harness that says nothing about turns
 * gets 32 — twice the observed median task — and a harness that speaks is heard.
 */

function foreverTools(callProvider: HarnessHost["callProvider"]): HarnessConfig {
	const echo: ToolDefinition = {
		name: "echo",
		description: "echoes",
		parameters: { kind: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
	return {
		model: "test-model",
		system: "you are a test",
		tools: toolRegistry([echo]),
	};
}

function loopingProvider(): HarnessHost["callProvider"] {
	return async function* callProvider(_request: ProviderRequest) {
		yield { type: "tool_call_start", id: "c", name: "echo" } as ProviderEvent;
		yield { type: "tool_arguments_delta", id: "c", delta: "{}" } as ProviderEvent;
		yield {
			type: "done",
			stopReason: "toolUse",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		} as ProviderEvent;
	};
}

async function outcomeOf(config: HarnessConfig): Promise<unknown> {
	const run = runAgent(config, { callProvider: loopingProvider() }, {
		message: userMessage("go"),
	});
	for await (const _event of run) {
		// drain
	}
	return await run.result();
}

describe("the turn limit default", () => {
	test("a harness that says nothing gets the default of 32", async () => {
		expect(DEFAULT_TURN_LIMIT).toBe(32);
		const config = foreverTools(loopingProvider());
		expect(await outcomeOf(config)).toEqual({ kind: "limitReached", turns: 32 });
	});

	test("a harness that speaks is heard, in both directions", async () => {
		expect(await outcomeOf({ ...foreverTools(loopingProvider()), turnLimit: 2 })).toEqual({
			kind: "limitReached",
			turns: 2,
		});
		const finite: HarnessHost["callProvider"] = async function* () {
			yield {
				type: "done",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			} as ProviderEvent;
		};
		const run = runAgent(
			{ ...foreverTools(finite), turnLimit: 2 },
			{ callProvider: finite },
			{ message: userMessage("go") },
		);
		for await (const _event of run) {
			// drain
		}
		expect(await run.result()).toEqual({ kind: "completed" });
	});
	test("the default makes 32 provider requests, not just 32 claims", async () => {
		let requests = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			requests += 1;
			yield { type: "tool_call_start", id: "c", name: "echo" } as ProviderEvent;
			yield { type: "tool_arguments_delta", id: "c", delta: "{}" } as ProviderEvent;
			yield {
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			} as ProviderEvent;
		};
		const run = runAgent(foreverTools(loopingProvider()), { callProvider: provider }, {
			message: userMessage("go"),
		});
		for await (const _event of run) {
			// drain
		}
		expect(await run.result()).toEqual({ kind: "limitReached", turns: 32 });
		expect(requests).toBe(32);
	});

	test("a limit of zero is heard: no provider request at all", async () => {
		let requests = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			requests += 1;
			yield { type: "done", stopReason: "stop" } as ProviderEvent;
		};
		const run = runAgent({ ...foreverTools(loopingProvider()), turnLimit: 0 }, {
			callProvider: provider,
		}, { message: userMessage("go") });
		for await (const _event of run) {
			// drain
		}
		expect(requests).toBe(0);
		expect(await run.result()).toEqual({ kind: "limitReached", turns: 0 });
	});

	test("a limit above the default is heard", async () => {
		let requests = 0;
		const provider: HarnessHost["callProvider"] = async function* () {
			requests += 1;
			yield { type: "tool_call_start", id: "c", name: "echo" } as ProviderEvent;
			yield { type: "tool_arguments_delta", id: "c", delta: "{}" } as ProviderEvent;
			yield {
				type: "done",
				stopReason: "toolUse",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			} as ProviderEvent;
		};
		const run = runAgent({ ...foreverTools(loopingProvider()), turnLimit: 64 }, {
			callProvider: provider,
		}, { message: userMessage("go") });
		for await (const _event of run) {
			// drain
		}
		expect(requests).toBe(64);
		expect(await run.result()).toEqual({ kind: "limitReached", turns: 64 });
	});
});
