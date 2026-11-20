/**
 * The driver.
 *
 * The only effectful part of MiHa. It performs the core's intents and feeds the
 * results back as inputs. It decides nothing: what runs, in what order and in which
 * group was settled by the core before the driver saw it.
 *
 * The driver's whole job is:
 *
 *   1. call the provider when the core asks, and feed its events back
 *   2. execute the plan's groups — in order, parallel within a group — and feed the
 *      results back
 *   3. hand the append intents to the host
 *   4. push the events to the stream
 *   5. race the whole thing against cancellation
 *
 * Events are pushed as they are produced, so the live view follows the run. Intents
 * are performed in the order the core emitted them.
 */

import { EventStream } from "./event-stream.ts";
import type { AgentEvent, Outcome, ProviderEvent } from "./events.ts";
import {
	initialState,
	step,
	type HarnessConfig,
	type Input,
	type Output,
	type ProviderRequest,
	type RunState,
} from "./run.ts";
import { failureResult, successResult, type ToolCallPlan, type ToolPlan } from "./tools.ts";
import type { AgentMessage, ToolResult, ToolResultMessage } from "./messages.ts";
import type { TranscriptEntry } from "./transcript.ts";

export interface HarnessHost {
	/** Performs one provider call and streams its events. */
	readonly callProvider: (
		request: ProviderRequest,
		signal: AbortSignal,
	) => AsyncIterable<ProviderEvent>;
	/** Performs one tool. The driver turns a throw into a result (law M3). */
	readonly callTool: (
		call: ToolCallPlan,
		signal: AbortSignal,
		report: (partial: ToolResult) => void,
	) => Promise<ToolResult>;
	/** Persists a transcript entry. The host may stamp it with a time. */
	readonly append?: (entry: TranscriptEntry) => void;
}

export interface RunOptions {
	readonly message: AgentMessage;
	readonly signal?: AbortSignal;
}

/**
 * Runs one agent.
 *
 * The returned stream carries the events and resolves with the outcome. It never
 * rejects for a provider failure or a failed tool — those are events. It rejects only
 * when the host itself misbehaves, which is a bug worth seeing.
 */
export function runAgent(
	config: HarnessConfig,
	host: HarnessHost,
	options: RunOptions,
): EventStream<AgentEvent, Outcome> {
	const stream = new EventStream<AgentEvent, Outcome>({
		isTerminal: (event) => event.type === "agent_end",
		extract: (event) => (event as { outcome: Outcome }).outcome,
	});

	const controller = new AbortController();
	const signal = options.signal ? mergeSignals([options.signal, controller.signal]) : controller.signal;

	let state: RunState = initialState(config);
	const intents: Output[] = [];

	const apply = (input: Input): void => {
		const result = step(state, input);
		state = result.state;
		for (const output of result.outputs) {
			if (output.kind === "event") stream.push(output.event);
			else intents.push(output);
		}
	};

	const perform = async (): Promise<void> => {
		apply({ kind: "prompt", message: options.message });

		while (state.phase !== "finished") {
			const intent = intents.shift();
			if (!intent) break;

			switch (intent.kind) {
				case "append":
					host.append?.(intent.entry);
					break;
				case "provider_request":
					for await (const event of host.callProvider(intent.request, signal)) {
						apply({ kind: "provider", event });
					}
					break;
				case "tool_plan":
					await runPlan(host, intent.plan, signal, (result) => {
						apply({ kind: "tool_result", result });
					}, (toolCallId, partial) => {
						apply({ kind: "tool_progress", toolCallId, partial });
					});
					break;
			}
		}
	};

	void (async () => {
		try {
			await perform();
			if (state.phase !== "finished") {
				// The machine has no more work but has not finished. Cancel it, so no
				// call is left unanswered.
				apply({ kind: "cancel" });
			}
		} catch (error) {
			stream.fail(error);
		}
	})();

	return stream;
}

/**
 * Executes a plan.
 *
 * Groups run in order; within a group the calls run together. The results are fed
 * back as they arrive, so the live view follows completion order while the core
 * records them in assistant order (law T4).
 */
async function runPlan(
	host: HarnessHost,
	plan: ToolPlan,
	signal: AbortSignal,
	accept: (result: ToolResultMessage) => void,
	progress: (toolCallId: string, partial: ToolResult) => void,
): Promise<void> {
	for (const group of plan.groups) {
		await Promise.all(group.map((entry) => runOne(host, entry, signal, accept, progress)));
	}
}

/**
 * Runs one call.
 *
 * The host does the running, not the driver: the host owns the tool, so the host may
 * wrap it, time it, or refuse it. A throw becomes a result (law M3).
 */
async function runOne(
	host: HarnessHost,
	entry: ToolCallPlan,
	signal: AbortSignal,
	accept: (result: ToolResultMessage) => void,
	progress: (toolCallId: string, partial: ToolResult) => void,
): Promise<void> {
	let result: ToolResult;
	try {
		result = await host.callTool(entry, signal, (partial) => progress(entry.call.id, partial));
	} catch (error) {
		accept(failureResult(entry.call, error));
		return;
	}
	accept(successResult(entry.call, result));
}

/**
 * Merges abort signals.
 *
 * `AbortSignal.any` is not everywhere yet, and a harness that runs in a page cannot
 * assume it. This is the smallest thing that does the job.
 */
export function mergeSignals(signals: readonly AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	const abort = (reason: unknown) => controller.abort(reason);
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		signal.addEventListener("abort", () => abort(signal.reason), { once: true });
	}
	return controller.signal;
}
