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
	DEFAULT_RESULT_BUDGET,
	cutText,
	resolveBudget,
	textBytes,
	truncateContent,
	truncateToolResult,
} from "./budget.ts";
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
	type TextContent,
	type ImageContent,
	type ThinkingContent,
} from "./messages.ts";
import type { AgentEvent, Outcome, ProviderEvent } from "./events.ts";
import {
	contextMessages,
	foldContext,
	initialContextState,
	messageBytes,
	resolveJournalWindow,
	DEFAULT_JOURNAL_WINDOW,
	JOURNAL_VERSION,
	type ContextItem,
	type ContextState,
	type JournalBody,
	type JournalEntry,
} from "./journal.ts";
import {
	planDispatch,
	reject,
	type ToolDefinition,
	type ToolPlan,
	type ToolRegistry,
} from "./tools.ts";

export type Phase = "idle" | "requesting" | "streaming" | "dispatching" | "settling" | "finished";

/** The default turn limit: 32, twice the observed median task (ADR 0009 D51). */
export const DEFAULT_TURN_LIMIT = 32;

/**
 * Resolves the host's turn limit into the one the core enforces.
 *
 * Zero is honoured: the run makes no provider request at all. A limit that is not a
 * number, or a negative one, is nonsense, and nonsense gets the default.
 */
export function resolveTurnLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_TURN_LIMIT;
	if (Number.isNaN(limit) || limit < 0) return DEFAULT_TURN_LIMIT;
	return limit;
}

export { DEFAULT_RESULT_BUDGET } from "./budget.ts";

/** The default context budget: 128 KiB of text (ADR 0010 D54). */
export const DEFAULT_CONTEXT_BUDGET = 131_072;

/**
 * Resolves the host's context budget into the one the core enforces.
 *
 * A budget that is not a number, or a negative one, is nonsense, and nonsense gets
 * the default. Zero is honoured: the core then keeps as little as it can.
 */
export function resolveContextBudget(budget: number | undefined): number {
	if (budget === undefined) return DEFAULT_CONTEXT_BUDGET;
	if (Number.isNaN(budget) || budget < 0) return DEFAULT_CONTEXT_BUDGET;
	return budget;
}

export interface HarnessConfig {
	readonly model: string;
	readonly system: string;
	readonly tools: ToolRegistry;
	/**
	 * How many provider requests a run may make. A policy, not a law (ADR 0006 D32);
	 * the default is 32 — twice the observed median task (ADR 0009 D51).
	 */
	readonly turnLimit?: number;
	/**
	 * The byte budget for one tool result's text, head and tail kept (ADR 0006 D34);
	 * the default is 8 192 B (ADR 0009 D50). `Infinity` disables it.
	 */
	readonly resultBudget?: number;
	/**
	 * How many journal entries the core keeps resident. The host holds the whole log;
	 * the core keeps a window, so the memory of a run does not grow with its length
	 * (law R1, ADR 0009 D52).
	 */
	readonly journalWindow?: number;
	/**
	 * How many bytes of text the model's context may hold. The core collapses what
	 * does not fit (ADR 0010 D54); the default is 128 KiB — twice the size of a
	 * median task.
	 */
	readonly contextBudget?: number;
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
	| { readonly kind: "blocked"; readonly call: ToolCallBlock; readonly reason: string }
	| { readonly kind: "compact"; readonly firstKeptSeq: number; readonly summary: string }
	| { readonly kind: "change"; readonly targetSeq: number; readonly content: readonly (TextContent | ImageContent)[] }
	| { readonly kind: "cancel" };

export type Output =
	| { readonly kind: "event"; readonly event: AgentEvent }
	| { readonly kind: "provider_request"; readonly request: ProviderRequest }
	| { readonly kind: "tool_plan"; readonly plan: ToolPlan }
	| { readonly kind: "append"; readonly entry: JournalEntry };

export interface Step {
	readonly state: RunState;
	readonly outputs: readonly Output[];
}

/** A refusal the host made, waiting to be written into the log. */
interface BlockInfo {
	readonly callId: string;
	readonly name: string;
	readonly reason: string;
}

/**
 * Writes one entry into the journal.
 *
 * The only place an entry is created: the sequence number is assigned here, the
 * context is folded forward here, and the resident window is kept here. Everything
 * that wants to record something goes through this, so the log and the context can
 * never drift apart.
 */
function write(
	state: RunState,
	body: JournalBody,
	outputs: Output[],
): { readonly entry: JournalEntry; readonly state: RunState } {
	const seq = state.nextId;
	const entry = { ...body, seq, version: JOURNAL_VERSION } as JournalEntry;
	const context = foldContext(state.context, entry);
	const kept = Math.max(0, state.entries.length + 1 - state.journalWindow);
	const entries = [...state.entries, entry].slice(kept);
	outputs.push({ kind: "append", entry });
	return { entry, state: { ...state, entries, context, nextId: seq + 1 } };
}

/**
 * A prompt, as the journal holds it.
 *
 * The prompt is recorded as it is — the role it carries and the content it holds —
 * so the record and the live event say the same thing. A prompt that is not a user
 * message is narrowed to what can be said: text and images, never a tool call.
 */
function promptBody(message: AgentMessage): JournalBody {
	if (message.role === "assistant") {
		return {
			kind: "message",
			role: "assistant",
			content: message.content.filter(
				(block): block is TextContent | ImageContent => block.type === "text" || block.type === "image",
			),
			usage: message.usage,
			stopReason: message.stopReason,
		};
	}
	return { kind: "message", role: "user", content: message.content };
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
	readonly blocks: readonly (TextContent | ImageContent | ThinkingContent)[];
	readonly calls: readonly AccumulatedCall[];
	readonly usage: Usage;
}

export interface RunState {
	readonly phase: Phase;
	readonly config: HarnessConfig;
	/** The resolved turn limit: the config's, or the default (ADR 0009 D51). */
	readonly turnLimit: number;
	/** The resolved result budget in bytes: the config's, or the default (ADR 0009 D50). */
	readonly resultBudget: number;
	/** The resident window of the journal. The host holds the whole log. */
	readonly entries: readonly JournalEntry[];
	/** The folded context: what the model sees. */
	readonly context: ContextState;
	/** The calls of the batch in flight whose answer is already in the log (law M1). */
	readonly written: readonly string[];
	/** The refusals the host made in this batch, waiting to be written. */
	readonly blocks: readonly BlockInfo[];
	/** How many entries stay resident (law R1). */
	readonly journalWindow: number;
	/** How many bytes of text the model's context may hold. */
	readonly contextBudget: number;
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
		turnLimit: resolveTurnLimit(config.turnLimit),
		resultBudget: resolveBudget(config.resultBudget),
		entries: [],
		context: initialContextState(),
		written: [],
		blocks: [],
		journalWindow: resolveJournalWindow(config.journalWindow),
		contextBudget: resolveContextBudget(config.contextBudget),
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
		case "blocked":
			return applyBlocked(state, input.call, input.reason);
		case "compact":
			return applyCompact(state, input.firstKeptSeq, input.summary);
		case "change":
			return applyChange(state, input.targetSeq, input.content);
		case "cancel":
			return cancelRun(state);
	}
}

function startRun(state: RunState, message: AgentMessage): Step {
	const outputs: Output[] = [{ kind: "event", event: { type: "agent_start" } }];
	const { entry, state: written } = write(state, promptBody(message), outputs);
	announce(outputs, `m${entry.seq}`, message);

	const next: RunState = { ...written, phase: "requesting", turn: 1 };
	return beginTurn(next, outputs);
}

function queueMessage(state: RunState, message: AgentMessage): Step {
	return { state: { ...state, queued: [...state.queued, message] }, outputs: [] };
}

/** Starts a provider turn: emits `turn_start` and asks the host to call the provider. */
function beginTurn(state: RunState, outputs: Output[]): Step {
	if (state.turn > state.turnLimit) {
		// The limit is spent: the run ends without asking the provider at all.
		return finish(state, { kind: "limitReached", turns: state.turnLimit }, outputs);
	}
	const request: ProviderRequest = {
		model: state.config.model,
		system: state.config.system,
		messages: contextMessages(state.context),
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
		// The message's id is the number its journal entry will carry: the id is
		// taken now, the entry is written when the message ends, and nothing is
		// written in between — so the sequence has no holes.
		const id = `m${current.nextId}`;
		current = {
			...current,
			phase: "streaming",
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

	const { entry, state: withMessage } = write(
		state,
		{
			kind: "message",
			role: "assistant",
			content: accumulator.blocks,
			usage: accumulator.usage,
			stopReason,
			...(errorMessage === undefined ? {} : { errorMessage }),
		},
		outputs,
	);
	outputs.push({ kind: "event", event: { type: "message_end", id: accumulator.id, message } });

	// The calls are entries of their own: the model's request and the tool's answer
	// are two facts, and the log holds both.
	let base: RunState = {
		...withMessage,
		accumulator: undefined,
		calls: accumulator.calls,
		results: [],
		written: [],
		blocks: [],
	};
	for (const call of accumulator.calls) {
		const written = write(
			base,
			{ kind: "tool_call", callId: call.id, name: call.name, argumentsText: call.argumentsText },
			outputs,
		);
		base = written.state;
	}

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
			const rejections = plan.rejections.map((result) => budgeted(base, result));
			const flushed = flushResults({ ...base, phase: "dispatching", results: rejections }, outputs);
			return endTurn(flushed, outputs, true);
		}

		const rejections = plan.rejections.map((result) => budgeted(base, result));
		return { state: { ...base, phase: "dispatching", results: rejections }, outputs };
	}

	if (accumulator.calls.length > 0) {
		// The turn ended before the calls could run — the provider failed, or the
		// output was cut short. The calls are in the transcript, so the transcript
		// has to answer them; they never ran, so the answer is an error (laws M1
		// and M4).
		const reason = undispatchedReason(stopReason, errorMessage);
		const results = accumulator.calls.map((call) => budgeted(base, syntheticResult(call, reason)));
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

/**
 * The one seam every tool result crosses before it reaches the transcript
 * (ADR 0009 D50): a rejection, a failure, a synthetic answer and a real result are
 * budgeted the same way. A result that crosses this seam twice is truncated twice,
 * so every path calls it exactly once.
 */
function budgeted(state: RunState, result: ToolResultMessage): ToolResultMessage {
	return truncateToolResult(result, state.resultBudget);
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
					partialResult: {
						...partial,
						content: truncateContent(partial.content, state.resultBudget),
					},
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
	let written = state;

	for (const call of state.calls) {
		const result =
			state.results.find((candidate) => candidate.toolCallId === call.id) ??
			budgeted(state, syntheticResult(call, "no result"));
		written = writeAnswer(written, call, result, state.blocks, outputs);
	}

	const writtenIds = [...state.written, ...state.calls.map((call) => call.id)];
	return { ...written, phase: "settling", results: state.results, written: writtenIds };
}

/**
 * Writes one answer into the log and tells the interface about it.
 *
 * The one place an answer becomes an entry: a refusal is a `block` entry, everything
 * else a `tool_result` entry, and both reach the model as one message. The refusal
 * and the answer travel the same road, so they cannot drift apart.
 */
function writeAnswer(
	state: RunState,
	call: { readonly id: string; readonly name: string },
	result: ToolResultMessage,
	blocks: readonly BlockInfo[],
	outputs: Output[],
): RunState {
	const refusal = blocks.find((block) => block.callId === call.id);
	const body: JournalBody = refusal
		? { kind: "block", callId: call.id, name: call.name, reason: refusal.reason }
		: {
				kind: "tool_result",
				callId: call.id,
				name: call.name,
				content: result.content,
				isError: result.isError,
				...(result.details === undefined ? {} : { details: result.details }),
			};
	const { entry, state: written } = write(state, body, outputs);
	const id = `m${entry.seq}`;
	outputs.push({ kind: "event", event: { type: "message_start", id, role: "toolResult" } });
	outputs.push({ kind: "event", event: { type: "message_end", id, message: result } });
	return written;
}

/**
 * A tool result arrived.
 *
 * Results are buffered and written in assistant order when the batch closes (law T4),
 * while the execution events go out as each result arrives, so the live view follows
 * completion order.
 */
function applyToolResult(state: RunState, incoming: ToolResultMessage): Step {
	if (state.phase !== "dispatching") return { state, outputs: [] };
	// An answer for a call this batch never made is not an answer to it: counting it
	// would make the batch look finished while a call of ours waits (law M1).
	if (!state.calls.some((call) => call.id === incoming.toolCallId)) return { state, outputs: [] };

	const result = budgeted(state, incoming);
	const results = replaceAnswer(state.results, result);
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

/**
 * The host refused a call.
 *
 * The refusal is the answer: the model reads why, and it recovers (law M1). The log
 * holds it as a `block` entry — the audit trail and the model's view are one fact.
 */
function applyBlocked(state: RunState, call: ToolCallBlock, reason: string): Step {
	if (state.phase !== "dispatching") return { state, outputs: [] };

	const message = budgeted(state, toolResultMessage(call.id, call.name, [{ type: "text", text: reason }], true));
	const outputs: Output[] = [
		{
			kind: "event",
			event: {
				type: "tool_execution_end",
				toolCallId: call.id,
				toolName: call.name,
				result: { content: message.content },
				isError: true,
			},
		},
	];

	const blocks = [...state.blocks, { callId: call.id, name: call.name, reason }];
	// A call has one answer: a refusal that arrives after an answer replaces it,
	// and it does not make the batch look finished (law M1).
	const results = replaceAnswer(state.results, message);

	if (results.length < state.calls.length) {
		return { state: { ...state, blocks, results }, outputs };
	}

	const flushed = flushResults({ ...state, blocks, results }, outputs);
	return endTurn(flushed, outputs, true);
}

/**
 * A range of the log collapsed into a summary.
 *
 * Compaction is not a feature of the core: it is a fold that collapses a range into
 * one summary entry (ADR 0008 D45). The history stays — the entries are still in the
 * log — and the model sees the summary instead of the range.
 */
function applyCompact(state: RunState, firstKeptSeq: number, summary: string): Step {
	const outputs: Output[] = [];
	// The sequence has no holes, so the entries before the boundary are exactly
	// `firstKeptSeq - 1` of them — counted over the log, not over the window, and
	// never more than the log holds.
	const dropped = Math.min(Math.max(0, firstKeptSeq - 1), Math.max(0, state.nextId - 1));
	const { state: written } = write(state, { kind: "compaction", firstKeptSeq, summary, dropped }, outputs);
	return { state: written, outputs };
}

/**
 * An earlier entry's model-facing view was replaced.
 *
 * The history is untouched: the log still says what the tool said, and the change
 * says what the model sees instead (ADR 0008 D45).
 */
function applyChange(
	state: RunState,
	targetSeq: number,
	content: readonly (TextContent | ImageContent)[],
): Step {
	const outputs: Output[] = [];
	const { state: written } = write(state, { kind: "change", targetSeq, content }, outputs);
	return { state: written, outputs };
}

/**
 * The answers of the batch, with one answer per call.
 *
 * A second answer for a call replaces the first: the call is answered once (law M1),
 * and the batch is not finished by answering the same call twice.
 */
function replaceAnswer(
	results: readonly ToolResultMessage[],
	result: ToolResultMessage,
): readonly ToolResultMessage[] {
	const index = results.findIndex((candidate) => candidate.toolCallId === result.toolCallId);
	if (index === -1) return [...results, result];
	const next = [...results];
	next[index] = result;
	return next;
}

/**
 * Tells the interface that a message entered the conversation.
 *
 * The live view follows the run: a message starts and ends, and the host sees both.
 */
function announce(outputs: Output[], id: string, message: AgentMessage): void {
	outputs.push({ kind: "event", event: { type: "message_start", id, role: message.role } });
	outputs.push({ kind: "event", event: { type: "message_end", id, message } });
}

/**
 * Collapses what does not fit into the context's budget.
 *
 * The core measures the folded context in bytes and, when it is over the budget,
 * collapses the oldest range into a digest and keeps what follows. The journal
 * keeps the whole history: a compaction is a fold, not a deletion (ADR 0008 D45).
 *
 * What cannot be shrunk is the range that follows: if those entries alone exceed
 * the budget, the context stays over it, and the core says so in the digest.
 */
function compactIfNeeded(state: RunState, outputs: Output[]): RunState {
	if (state.context.bytes <= state.contextBudget) return state;

	const items = state.context.items;
	const prefix = textBytes(COMPACTED_PREFIX);
	// The digest gets at least a quarter of the budget: a summary that says
	// nothing is no summary. The entries that follow take what is left, and the
	// digest takes what they leave — so the context after the collapse fits.
	const minimum = Math.floor(state.contextBudget / 4);
	const room = Math.max(0, state.contextBudget - minimum - prefix);
	let kept = 0;
	let bytes = 0;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item === undefined) break;
		const size = messageBytes(item.message);
		if (kept > 0 && bytes + size > room) break;
		bytes += size;
		kept += 1;
	}

	// The range that follows is the newest `kept` items: `items.length - kept` is
	// where it begins. Counting from the front instead would leave the range that
	// does not fit standing.
	const boundary = items[items.length - kept]?.seq;
	if (boundary === undefined) return state;

	const collapsed = items.slice(0, items.length - kept);
	// The digest always has room to say something: a summary that says nothing is
	// no summary, and the law's exception already covers a context that cannot fit.
	const digestRoom = Math.max(minimum, state.contextBudget - bytes - prefix);
	const summary = digest(collapsed, digestRoom);
	const { state: written } = write(
		state,
		{ kind: "compaction", firstKeptSeq: boundary, summary, dropped: collapsed.length },
		outputs,
	);
	return written;
}

/** What the fold writes in front of a digest, so the model knows it is lossy. */
const COMPACTED_PREFIX = "[compacted] ";

/**
 * A digest of what was collapsed: one line per message, the first words of it.
 *
 * The digest is mechanical and lossy, and it says so: the model is told that this is
 * a summary of what came before, not the thing itself. A host that can write a better
 * summary — by asking the model — replaces it with a `change` entry.
 *
 * It is cut to the room it was given, in bytes and never inside a codepoint: a
 * digest that does not fit is worse than a digest that fits, and a broken character
 * in the model's context is worse than both.
 */
function digest(items: readonly ContextItem[], room: number): string {
	const lines: string[] = [];
	for (const item of items) {
		const message = item.message;
		let text: string;
		if (message.role === "user") {
			text = typeof message.content === "string" ? message.content : blocksText(message.content);
		} else {
			text = blocksText(message.content);
		}
		lines.push(`${message.role}: ${text.slice(0, 120)}`);
	}
	return cutText(`${items.length} entries collapsed: ${lines.join(" | ")}`, room);
}

/** The text of a message's blocks, one after another. */
function blocksText(blocks: readonly (TextContent | ImageContent | ThinkingContent | ToolCallBlock)[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "thinking") parts.push(block.thinking);
		else if (block.type === "toolCall") parts.push(`${block.name}(${block.argumentsText})`);
	}
	return parts.join(" ");
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
	const messages = contextMessages(state.context);
	const last = messages[messages.length - 1] ?? userMessage("");
	outputs.push({
		kind: "event",
		event: { type: "turn_end", message: last, toolResults: state.results },
	});

	if (state.turn >= state.turnLimit) {
		return finish(state, { kind: "limitReached", turns: state.turn }, outputs);
	}

	if (state.queued.length > 0) {
		const next = state.queued[0];
		if (next === undefined) return finish(state, { kind: "completed" }, outputs);
		const rest = state.queued.slice(1);
		const { entry, state: written } = write(state, promptBody(next), outputs);
		announce(outputs, `m${entry.seq}`, next);
		const prepared: RunState = {
			...written,
			phase: "requesting",
			queued: rest,
			results: [],
			turn: state.turn + 1,
		};
		// The context is bounded after everything this turn put into it: the queued
		// message is part of the context now, and the request must fit.
		return beginTurn(compactIfNeeded(prepared, outputs), outputs);
	}

	if (hadToolCalls) {
		const prepared: RunState = { ...state, phase: "requesting", results: [], turn: state.turn + 1 };
		return beginTurn(compactIfNeeded(prepared, outputs), outputs);
	}

	return finish(state, { kind: "completed" }, outputs);
}

function finish(state: RunState, outcome: Outcome, outputs: Output[]): Step {
	const messages = contextMessages(state.context);
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
	let written = state;

	for (const call of state.calls) {
		// What is already in the log is tracked, not looked up: the log is windowed,
		// and a call that already has its answer must not get a second one (law M1).
		// An answer the run holds but never wrote — the batch did not close — is
		// written now, or the call would be a hole in the log.
		if (state.written.includes(call.id)) continue;
		const buffered = state.results.find((result) => result.toolCallId === call.id);
		const result = buffered ?? budgeted(state, syntheticResult(call, "cancelled"));
		written = writeAnswer(written, call, result, state.blocks, outputs);
	}

	const finished: RunState = { ...written, phase: "finished" };
	return finish(finished, { kind: "cancelled" }, outputs);
}

/** Exported for the driver: the outcome of a finished run. */
export function outcomeOf(state: RunState): Outcome | undefined {
	return state.outcome;
}

export { validate };
export type { ToolResult, ToolResultMessage };
