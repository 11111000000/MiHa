/**
 * The state machine.
 *
 * The core is a pure transition function: it consumes an input and returns a new state
 * plus a list of **intents**. It never calls a provider, never runs a tool and never
 * writes to storage (ADR 0005 D24, ADR 0006 D31).
 *
 * Six states. The phase is data, not control flow, so a run can be inspected,
 * serialised or resumed — and cancellation is total: every live state can reach
 * `finished`.
 *
 * The laws this machine maintains:
 *
 *   M1  every tool call receives exactly one tool result — on abort, on truncation,
 *       on provider error, on an unknown tool
 *   M2  a call whose arguments did not arrive complete is never executed
 *   M3  a failed tool is a result with `isError`, never ordinary content
 *   M4  a provider failure is an event, and the pairing of M1 survives it
 *   T4  tool results are recorded in assistant order
 */

import { validate } from "../schema/dialect.ts";
import { assertNever } from "./exhaustive.ts";
import {
	assistantMessage,
	emptyUsage,
	toolCall,
	toolResultMessage,
	userMessage,
	type AgentMessage,
	type AssistantMessage,
	type ContentBlock,
	type StopReason,
	type ToolCallBlock,
	type ToolResult,
	type ToolResultMessage,
	type Usage,
} from "./messages.ts";
import type { AgentEvent, Outcome, ProviderEvent } from "./events.ts";
import { appendEntry, messageEntry, modelMessages, type TranscriptEntry } from "./transcript.ts";
import {
	planDispatch,
	reject,
	type ToolDefinition,
	type ToolPlan,
	type ToolRegistry,
} from "./tools.ts";

export type Phase = "idle" | "requesting" | "streaming" | "dispatching" | "settling" | "finished";

export interface HarnessConfig {
	readonly model: string;
	readonly system: string;
	readonly tools: ToolRegistry;
	/** How many provider requests a run may make. A policy, not a law (ADR 0006 D32). */
	readonly turnLimit: number;
	readonly options?: Readonly<Record<string, unknown>>;
}

/** The flat request the host lowers to the provider's wire format (ADR 0006 D30). */
export interface ProviderRequest {
	readonly model: string;
	readonly system: string;
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly ToolDefinition[];
	readonly options?: Readonly<Record<string, unknown>>;
}

export type Input =
	| { readonly kind: "prompt"; readonly message: AgentMessage }
	| { readonly kind: "steer"; readonly message: AgentMessage }
	| { readonly kind: "provider"; readonly event: ProviderEvent }
	| { readonly kind: "tool_progress"; readonly toolCallId: string; readonly partial: ToolResult }
	| { readonly kind: "tool_result"; readonly result: ToolResultMessage }
	| { readonly kind: "cancel" };

export type Output =
	| { readonly kind: "event"; readonly event: AgentEvent }
	| { readonly kind: "provider_request"; readonly request: ProviderRequest }
	| { readonly kind: "tool_plan"; readonly plan: ToolPlan }
	| { readonly kind: "append"; readonly entry: TranscriptEntry };

export interface Step {
	readonly state: RunState;
	readonly outputs: readonly Output[];
}

/** A call being accumulated while the provider streams it. */
interface AccumulatedCall {
	readonly id: string;
	readonly name: string;
	readonly argumentsText: string;
}

/** The assistant message as it stands while the provider streams it. */
interface Accumulator {
	readonly id: string;
	readonly blocks: readonly ContentBlock[];
	readonly calls: readonly AccumulatedCall[];
	readonly usage: Usage;
}

export interface RunState {
	readonly phase: Phase;
	readonly config: HarnessConfig;
	readonly entries: readonly TranscriptEntry[];
	/** How many provider requests have been made. */
	readonly turn: number;
	/** The next id the core will hand out. Deterministic, so a run replays. */
	readonly nextId: number;
	readonly accumulator: Accumulator | undefined;
	/** The calls of the batch in flight, in assistant order. */
	readonly calls: readonly AccumulatedCall[];
	/** The results received so far for the batch in flight. */
	readonly results: readonly ToolResultMessage[];
	/** Messages the user sent while the agent was working. */
	readonly queued: readonly AgentMessage[];
	readonly outcome: Outcome | undefined;
}

export function initialState(config: HarnessConfig): RunState {
	return {
		phase: "idle",
		config,
		entries: [],
		turn: 0,
		nextId: 1,
		accumulator: undefined,
		calls: [],
		results: [],
		queued: [],
		outcome: undefined,
	};
}

/**
 * Applies an input.
 *
 * An input that does not apply to the current state is ignored — the machine stays
 * where it is. That is not an accident: a provider event that arrives after a
 * cancellation must not resurrect the run.
 */
export function step(state: RunState, input: Input): Step {
	switch (input.kind) {
		case "prompt":
			return state.phase === "idle" ? startRun(state, input.message) : queueMessage(state, input.message);
		case "steer":
			return queueMessage(state, input.message);
		case "provider":
			return applyProvider(state, input.event);
		case "tool_progress":
			return applyToolProgress(state, input.toolCallId, input.partial);
		case "tool_result":
			return applyToolResult(state, input.result);
		case "cancel":
			return cancelRun(state);
	}
}

function startRun(state: RunState, message: AgentMessage): Step {
	const id = `m${state.nextId}`;
	const entry = messageEntry(id, message);
	const entries = appendEntry(state.entries, entry);
	const outputs: Output[] = [
		{ kind: "event", event: { type: "agent_start" } },
		{ kind: "append", entry },
		{ kind: "event", event: { type: "message_start", id, role: "user" } },
		{ kind: "event", event: { type: "message_end", id, message } },
	];

	const next: RunState = { ...state, phase: "requesting", entries, nextId: state.nextId + 1, turn: 1 };
	return beginTurn(next, outputs);
}

function queueMessage(state: RunState, message: AgentMessage): Step {
	return { state: { ...state, queued: [...state.queued, message] }, outputs: [] };
}

/** Starts a provider turn: emits `turn_start` and asks the host to call the provider. */
function beginTurn(state: RunState, outputs: Output[]): Step {
	const request: ProviderRequest = {
		model: state.config.model,
		system: state.config.system,
		messages: modelMessages(state.entries),
		tools: [...state.config.tools.values()],
		...(state.config.options === undefined ? {} : { options: state.config.options }),
	};
	outputs.push({ kind: "event", event: { type: "turn_start" } });
	outputs.push({ kind: "provider_request", request });
	return { state: { ...state, phase: "requesting" }, outputs };
}

function applyProvider(state: RunState, event: ProviderEvent): Step {
	if (state.phase === "finished") return { state, outputs: [] };

	let current = state;
	const outputs: Output[] = [];

	if (current.phase === "requesting") {
		const id = `m${current.nextId}`;
		current = {
			...current,
			phase: "streaming",
			nextId: current.nextId + 1,
			accumulator: { id, blocks: [], calls: [], usage: emptyUsage },
		};
		outputs.push({ kind: "event", event: { type: "message_start", id, role: "assistant" } });
	}

	if (current.phase !== "streaming" || !current.accumulator) {
		return { state: current, outputs };
	}

	const accumulator = current.accumulator;

	switch (event.type) {
		case "text_delta":
			return accumulateText(current, accumulator, event.delta, outputs);
		case "reasoning_delta":
			return accumulateReasoning(current, accumulator, event.delta, outputs);
		case "tool_call_start":
			return startCall(current, accumulator, event.id, event.name, outputs);
		case "tool_arguments_delta":
			return extendCall(current, accumulator, event.id, event.delta, outputs);
		case "error":
			return finaliseAssistant(current, accumulator, "error", event.message, outputs);
		case "done":
			return finaliseAssistant(current, accumulator, event.stopReason, undefined, outputs);
	}
}

/** Appends to the trailing text block, or starts one. */
function accumulateText(
	state: RunState,
	accumulator: Accumulator,
	delta: string,
	outputs: Output[],
): Step {
	const blocks = [...accumulator.blocks];
	const last = blocks[blocks.length - 1];
	if (last && last.type === "text") {
		blocks[blocks.length - 1] = { type: "text", text: last.text + delta };
	} else {
		blocks.push({ type: "text", text: delta });
	}
	return emitUpdate(state, { ...accumulator, blocks }, outputs, {
		type: "text_delta",
		delta,
	});
}

function accumulateReasoning(
	state: RunState,
	accumulator: Accumulator,
	delta: string,
	outputs: Output[],
): Step {
	const blocks = [...accumulator.blocks];
	const last = blocks[blocks.length - 1];
	if (last && last.type === "thinking") {
		blocks[blocks.length - 1] = { type: "thinking", thinking: last.thinking + delta };
	} else {
		blocks.push({ type: "thinking", thinking: delta });
	}
	return emitUpdate(state, { ...accumulator, blocks }, outputs, {
		type: "reasoning_delta",
		delta,
	});
}

function startCall(
	state: RunState,
	accumulator: Accumulator,
	id: string,
	name: string,
	outputs: Output[],
): Step {
	const calls = [...accumulator.calls, { id, name, argumentsText: "" }];
	return emitUpdate(state, { ...accumulator, calls }, outputs, {
		type: "tool_call_start",
		id,
		name,
	});
}

function extendCall(
	state: RunState,
	accumulator: Accumulator,
	id: string,
	delta: string,
	outputs: Output[],
): Step {
	const calls = accumulator.calls.map((call) =>
		call.id === id ? { ...call, argumentsText: call.argumentsText + delta } : call,
	);
	return emitUpdate(state, { ...accumulator, calls }, outputs, {
		type: "tool_arguments_delta",
		id,
		delta,
	});
}

function emitUpdate(
	state: RunState,
	accumulator: Accumulator,
	outputs: Output[],
	providerEvent: ProviderEvent,
): Step {
	outputs.push({
		kind: "event",
		event: {
			type: "message_update",
			id: accumulator.id,
			message: { role: "assistant", content: accumulator.blocks },
			providerEvent,
		},
	});
	return { state: { ...state, accumulator }, outputs };
}

/**
 * Writes the assistant message and decides what happens next.
 *
 * With tool calls that may run, the batch is planned and the run waits for the
 * results. The calls are recorded whatever the stop reason: a call the transcript
 * holds and nothing answers is a hole the next request would trip on (law M1). So a
 * turn that ends without dispatching its calls still answers them.
 */
function finaliseAssistant(
	state: RunState,
	accumulator: Accumulator,
	stopReason: StopReason,
	errorMessage: string | undefined,
	outputs: Output[],
): Step {
	const calls: readonly ToolCallBlock[] = accumulator.calls.map((call) =>
		toolCall(call.id, call.name, call.argumentsText),
	);
	const content: readonly ContentBlock[] = [...accumulator.blocks, ...calls];
	const message: AssistantMessage = assistantMessage(
		content,
		stopReason,
		accumulator.usage,
		errorMessage,
	);

	const entry = messageEntry(accumulator.id, message);
	const entries = appendEntry(state.entries, entry);
	outputs.push({ kind: "append", entry });
	outputs.push({ kind: "event", event: { type: "message_end", id: accumulator.id, message } });

	const base: RunState = {
		...state,
		entries,
		accumulator: undefined,
		calls: accumulator.calls,
		results: [],
	};

	if (stopReason === "toolUse" && accumulator.calls.length > 0) {
		const plan = planDispatch(calls, state.config.tools, state.turn);
		outputs.push({ kind: "tool_plan", plan });
		for (const group of plan.groups) {
			for (const entry of group) {
				outputs.push({
					kind: "event",
					event: {
						type: "tool_execution_start",
						toolCallId: entry.call.id,
						toolName: entry.tool.name,
						args: entry.args,
					},
				});
			}
		}

		if (plan.groups.length === 0) {
			// Every call was rejected, so the batch is already answered and the driver
			// has nothing to execute. Closing it here is what keeps the pairing whole.
			const flushed = flushResults({ ...base, phase: "dispatching", results: plan.rejections }, outputs);
			return endTurn(flushed, outputs, true);
		}

		return { state: { ...base, phase: "dispatching", results: plan.rejections }, outputs };
	}

	if (accumulator.calls.length > 0) {
		// The turn ended before the calls could run — the provider failed, or the
		// output was cut short. The calls are in the transcript, so the transcript
		// has to answer them; they never ran, so the answer is an error (laws M1
		// and M4).
		const reason = undispatchedReason(stopReason, errorMessage);
		const results = accumulator.calls.map((call) => syntheticResult(call, reason));
		const flushed = flushResults({ ...base, phase: "dispatching", results }, outputs);
		return endTurn(flushed, outputs, false);
	}

	return endTurn({ ...base, phase: "settling" }, outputs, false);
}

/** Why a call was streamed and never dispatched. */
function undispatchedReason(stopReason: StopReason, errorMessage: string | undefined): string {
	switch (stopReason) {
		case "error":
			return `the provider failed before this call could run: ${errorMessage ?? "unknown error"}`;
		case "length":
			return "the output was cut short before this call could run — re-issue it";
		case "stop":
		case "aborted":
		case "toolUse":
			return "the turn ended before this call could run — re-issue it if it still matters";
		default:
			return assertNever(stopReason);
	}
}

/** A tool reported partial progress. */
function applyToolProgress(state: RunState, toolCallId: string, partial: ToolResult): Step {
	if (state.phase !== "dispatching") return { state, outputs: [] };
	const call = state.calls.find((candidate) => candidate.id === toolCallId);
	if (!call) return { state, outputs: [] };
	return {
		state,
		outputs: [
			{
				kind: "event",
				event: {
					type: "tool_execution_update",
					toolCallId,
					toolName: call.name,
					args: {},
					partialResult: partial,
				},
			},
		],
	};
}

/**
 * Writes a closed batch's results to the transcript, in assistant order (law T4).
 *
 * Every call of the batch is answered here — including the ones the planner
 * rejected, and including any that somehow went unanswered, which get a synthetic
 * error result rather than a hole in the transcript (law M1).
 */
function flushResults(state: RunState, outputs: Output[]): RunState {
	const ordered = state.calls.map(
		(call) => state.results.find((result) => result.toolCallId === call.id) ?? syntheticResult(call, "no result"),
	);

	let entries = state.entries;
	let nextId = state.nextId;

	for (const result of ordered) {
		const id = `m${nextId}`;
		const entry = messageEntry(id, result);
		entries = appendEntry(entries, entry);
		nextId += 1;
		outputs.push({ kind: "append", entry });
		outputs.push({ kind: "event", event: { type: "message_start", id, role: "toolResult" } });
		outputs.push({ kind: "event", event: { type: "message_end", id, message: result } });
	}

	return { ...state, phase: "settling", entries, nextId, results: ordered };
}

/**
 * A tool result arrived.
 *
 * Results are buffered and written in assistant order when the batch closes (law T4),
 * while the execution events go out as each result arrives, so the live view follows
 * completion order.
 */
function applyToolResult(state: RunState, result: ToolResultMessage): Step {
	if (state.phase !== "dispatching") return { state, outputs: [] };

	const results = [...state.results, result];
	const outputs: Output[] = [
		{
			kind: "event",
			event: {
				type: "tool_execution_end",
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				result: { content: result.content, ...(result.details === undefined ? {} : { details: result.details }) },
				isError: result.isError,
			},
		},
	];

	if (results.length < state.calls.length) {
		return { state: { ...state, results }, outputs };
	}

	const flushed = flushResults({ ...state, results }, outputs);
	return endTurn(flushed, outputs, true);
}

/** A call that never ran still gets an answer (law M1). */
function syntheticResult(call: AccumulatedCall, reason: string): ToolResultMessage {
	return toolResultMessage(call.id, call.name, [{ type: "text", text: reason }], true);
}

/**
 * Ends a turn and decides whether another one follows.
 *
 * A queued message goes first — the user spoke, so the user is answered next. Then
 * the turn limit, then whether the agent has anything left to do.
 */
function endTurn(state: RunState, outputs: Output[], hadToolCalls: boolean): Step {
	const messages = modelMessages(state.entries);
	const last = messages[messages.length - 1] ?? userMessage("");
	outputs.push({
		kind: "event",
		event: { type: "turn_end", message: last, toolResults: state.results },
	});

	if (state.turn >= state.config.turnLimit) {
		return finish(state, { kind: "limitReached", turns: state.turn }, outputs);
	}

	if (state.queued.length > 0) {
		const next = state.queued[0];
		if (next === undefined) return finish(state, { kind: "completed" }, outputs);
		const rest = state.queued.slice(1);
		const id = `m${state.nextId}`;
		const entry = messageEntry(id, next);
		const entries = appendEntry(state.entries, entry);
		outputs.push({ kind: "append", entry });
		outputs.push({ kind: "event", event: { type: "message_start", id, role: "user" } });
		outputs.push({ kind: "event", event: { type: "message_end", id, message: next } });
		const prepared: RunState = {
			...state,
			phase: "requesting",
			entries,
			nextId: state.nextId + 1,
			queued: rest,
			results: [],
			turn: state.turn + 1,
		};
		return beginTurn(prepared, outputs);
	}

	if (hadToolCalls) {
		const prepared: RunState = { ...state, phase: "requesting", results: [], turn: state.turn + 1 };
		return beginTurn(prepared, outputs);
	}

	return finish(state, { kind: "completed" }, outputs);
}

function finish(state: RunState, outcome: Outcome, outputs: Output[]): Step {
	const messages = modelMessages(state.entries);
	outputs.push({ kind: "event", event: { type: "agent_end", messages, outcome } });
	return { state: { ...state, phase: "finished", outcome }, outputs };
}

/**
 * Cancellation.
 *
 * Every live state can reach `finished`. The calls that were in flight still get an
 * answer (law M1), because a transcript with an unanswered call cannot be replayed.
 */
function cancelRun(state: RunState): Step {
	if (state.phase === "finished") return { state, outputs: [] };

	const outputs: Output[] = [];
	let entries = state.entries;
	let nextId = state.nextId;

	for (const call of state.calls) {
		// The transcript says what has been answered, not the turn's buffer: the
		// buffer is cleared when the next turn starts while the calls stay, and a
		// call that already has its answer must not get a second one (law M1).
		if (hasResult(entries, call.id)) continue;
		const buffered = state.results.find((result) => result.toolCallId === call.id);
		const result = buffered ?? syntheticResult(call, "cancelled");
		const id = `m${nextId}`;
		const entry = messageEntry(id, result);
		entries = appendEntry(entries, entry);
		nextId += 1;
		outputs.push({ kind: "append", entry });
		outputs.push({ kind: "event", event: { type: "message_start", id, role: "toolResult" } });
		outputs.push({ kind: "event", event: { type: "message_end", id, message: result } });
	}

	const finished: RunState = { ...state, phase: "finished", entries, nextId };
	return finish(finished, { kind: "cancelled" }, outputs);
}

/** True when the transcript already holds a result for the call (law M1). */
function hasResult(entries: readonly TranscriptEntry[], toolCallId: string): boolean {
	return entries.some(
		(entry) => entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId,
	);
}

/** Exported for the driver: the outcome of a finished run. */
export function outcomeOf(state: RunState): Outcome | undefined {
	return state.outcome;
}

export { validate };
export type { ToolResult, ToolResultMessage };
