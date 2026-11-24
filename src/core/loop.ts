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
	phaseOf,
	step,
	type HarnessConfig,
	type Input,
	type Output,
	type Phase,
	type ProviderRequest,
	type RunState,
} from "./run.ts";
import {
	failureResult,
	reject,
	successResult,
	type ToolCallPlan,
	type ToolDefinition,
	type ToolPlan,
} from "./tools.ts";
import { validate } from "../schema/dialect.ts";
import type { ToolCallBlock } from "./messages.ts";
import type { AgentMessage, ToolResult, ToolResultMessage } from "./messages.ts";
import type { JournalEntry } from "./journal.ts";

/**
 * What the host answers when the driver asks about a call (ADR 0008 D44).
 *
 * - `allow` — run the call as planned.
 * - `deny` — refuse it. The reason reaches the model as an ordinary error result, so
 *   it can tell the user what was refused and why.
 * - `rewrite` — replace the arguments. The replacement is **re-validated**; a rewrite
 *   that breaks the dialect is refused rather than run.
 */
export type ApproveDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "deny"; readonly reason: string }
	| { readonly kind: "rewrite"; readonly args: Readonly<Record<string, unknown>> };

export interface ApproveContext {
	readonly call: ToolCallBlock;
	readonly tool: ToolDefinition;
	/** The validated arguments, before a rewrite may narrow them. */
	readonly args: Readonly<Record<string, unknown>>;
}

/**
 * The one permission seam. It is **asynchronous** because the host may have to ask a
 * human, and asking a human is the core interaction of the applications this harness
 * is for. There is no permission engine in MiHa: the policy belongs to the host, which
 * already knows what its user allowed.
 */
export type Approve = (context: ApproveContext) => Promise<ApproveDecision>;

/**
 * The request seam (ADR 0006 D35).
 *
 * The host may rewrite the request in flight: elide a stale result, switch the model
 * for one turn, attach a deadline, force a compaction. The driver calls the seam
 * between "the core emitted a `provider_request`" and "the provider performs it", and
 * the provider receives exactly what the seam returned.
 *
 * The seam may be synchronous or asynchronous, and it is given the run's signal — so
 * a host can see the abort and stop waiting.
 */
export type PrepareRequest = (
	request: ProviderRequest,
	signal: AbortSignal,
) => ProviderRequest | Promise<ProviderRequest>;

export interface HarnessHost {
	/** Performs one provider call and streams its events. */
	readonly callProvider: (
		request: ProviderRequest,
		signal: AbortSignal,
	) => AsyncIterable<ProviderEvent>;
	/** Persists a journal entry. The host may stamp it with a time. */
	readonly append?: (entry: JournalEntry) => void;
	/** Asked before each tool runs. Absent means every planned tool runs. */
	readonly approve?: Approve;
	/** Rewrites the request in flight. Absent means the provider gets the core's request as it is. */
	readonly prepareRequest?: PrepareRequest;
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
			if (output.kind === "event") {
				// The run ends with the terminal event, and the host must have the
				// last entries before it: a consumer that closes on the terminal
				// event would otherwise lose them.
				if (output.event.type === "agent_end") flushEntries();
				stream.push(output.event);
			} else intents.push(output);
		}
	};

	/**
	 * The phase as it stands now. A call, because `apply` moves it on.
	 *
	 * The phase is derived from the state, never stored in it (ADR 0008 D48), so the
	 * driver reads the same label the state says — and the run is over when the label
	 * says `finished`.
	 */
	const phase = (): Phase => phaseOf(state);

	// The outside world may stop the run. The merged signal cuts the host's work
	// short, but the core has to be told as well: a run that merely ran out of work
	// would report that instead of a cancellation.
	const onAbort = (): void => {
		apply({ kind: "cancel" });
	};
	if (options.signal && !options.signal.aborted) {
		options.signal.addEventListener("abort", onAbort, { once: true });
	}

	const perform = async (): Promise<void> => {
		apply({ kind: "prompt", message: options.message });
		if (options.signal?.aborted) {
			// Cancelled before the first turn: the run still starts, and it still ends.
			apply({ kind: "cancel" });
			flushEntries();
			return;
		}

		while (phaseOf(state) !== "finished") {
			const intent = intents.shift();
			if (!intent) break;

			switch (intent.kind) {
				case "append":
					host.append?.(intent.entry);
					break;
				case "provider_request": {
					let request = intent.request;
					if (host.prepareRequest) {
						try {
							// The seam's wait is raced against the run's abort: a host
							// that ignores the signal does not keep the run waiting, and
							// a request that was not prepared is never performed.
							request = await raceWithAbort(prepareThrough(host, request, signal), signal);
						} catch (error) {
							// The seam's failure is the provider's failure: it becomes an
							// event, so the run reports it and the pairing survives (law M1).
							apply({
								kind: "provider",
								event: {
									type: "error",
									message: `the request could not be prepared: ${messageOf(error)}`,
								},
							});
							// A host that failed ends the turn here: there is no request to
							// perform. An abort is the other case — the run is already over,
							// and the phase below says so.
							if (!signal.aborted) break;
						}
						if (!isRequest(request)) {
							// The seam returned nothing. A request that was never built is
							// not one that can be performed, so it is refused the way a
							// seam that throws is.
							apply({
								kind: "provider",
								event: {
									type: "error",
									message: "the request could not be prepared: the host returned no request",
								},
							});
							break;
						}
					}
					// The run is over — cancelled while the seam waited, or the seam
					// failed — so the provider is not called. The seam's `await` is a
					// window between "the core asked" and "the provider performs it",
					// and the cancellation races throughout.
					if (phase() === "finished") break;
					for await (const event of host.callProvider(request, signal)) {
						apply({ kind: "provider", event });
						// The run is over — cancelled, or the last turn — so the rest of
						// the provider's stream is of no interest.
						if (phase() === "finished") break;
					}
					break;
				}
				case "tool_plan":
					await runPlan(intent.plan, {
						signal,
						approve: host.approve,
						accept: (result) => {
							apply({ kind: "tool_result", result });
						},
						block: (call, reason) => {
							apply({ kind: "blocked", call, reason });
						},
						progress: (toolCallId, partial) => {
							apply({ kind: "tool_progress", toolCallId, partial });
						},
					});
					break;
			}
		}

		flushEntries();
	};

	/**
	 * Hands the host the entries the run wrote.
	 *
	 * The loop stops the moment the machine finishes, and the appends of that final
	 * turn are still queued. A transcript the host never saw is a transcript the host
	 * cannot keep — so they are handed over, whether the run ended normally, was
	 * cancelled before its first request, or the provider threw.
	 */
	const flushEntries = (): void => {
		for (const intent of intents) {
			if (intent.kind === "append") host.append?.(intent.entry);
		}
		intents.length = 0;
	};

	void (async () => {
		try {
			await perform();
			if (phaseOf(state) !== "finished") {
				// The machine has no more work but has not finished. Cancel it, so no
				// call is left unanswered.
				apply({ kind: "cancel" });
			}
		} catch (error) {
			// The provider threw: the entries the run wrote are still the host's.
			flushEntries();
			stream.fail(error);
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			// The run is over, so whatever the host still has running stops too.
			controller.abort();
		}
	})();

	return stream;
}

/**
 * What the driver needs to run a plan.
 *
 * The signal, the host's approval, and the three ways back into the core: an
 * answer, a refusal, a partial result.
 */
interface PlanContext {
	readonly signal: AbortSignal;
	readonly approve: Approve | undefined;
	readonly accept: (result: ToolResultMessage) => void;
	readonly block: (call: ToolCallBlock, reason: string) => void;
	readonly progress: (toolCallId: string, partial: ToolResult) => void;
}

/**
 * Executes a plan.
 *
 * Groups run in order; within a group the calls run together. The results are fed
 * back as they arrive, so the live view follows completion order while the core
 * records them in assistant order (law T4).
 */
async function runPlan(plan: ToolPlan, context: PlanContext): Promise<void> {
	for (const group of plan.groups) {
		await Promise.all(group.map((entry) => runOne(entry, context)));
	}
}

/**
 * Runs one call.
 *
 * The **driver** runs the tool, not the host. The host owns the tool's *policy* — the
 * approve seam, awaited here, which may wait for a human — and the *capabilities* the
 * tool may use. Running the tool here means the tool always receives arguments the core
 * or the seam validated, never the raw text (ADR 0008 D44, D47). A throw becomes a
 * result (M3).
 */
async function runOne(entry: ToolCallPlan, context: PlanContext): Promise<void> {
	const { signal, approve, accept, block, progress } = context;
	let args = entry.args;

	if (approve) {
		let decision: ApproveDecision;
		try {
			decision = await approve({ call: entry.call, tool: entry.tool, args: entry.args });
		} catch (error) {
			accept(failureResult(entry.call, error));
			return;
		}
		if (decision.kind === "deny") {
			// The refusal is the model's answer: it reads why, and it recovers.
			block(entry.call, decision.reason);
			return;
		}
		if (decision.kind === "rewrite") {
			const rewritten = validate(entry.tool.parameters, decision.args);
			if (!rewritten.ok) {
				accept(
					reject(entry.call, `host rewrote the arguments badly — ${rewritten.error.path || "/"}: ${rewritten.error.message}`),
				);
				return;
			}
			args = rewritten.value as Record<string, unknown>;
		}
	}

	let result: ToolResult;
	try {
		result = await entry.tool.execute(entry.call, args, signal, (partial) => progress(entry.call.id, partial));
	} catch (error) {
		accept(failureResult(entry.call, error));
		return;
	}
	accept(successResult(entry.call, result));
}

/**
 * The message of a thrown value.
 *
 * A host that throws is reported the way the provider's own failures are reported:
 * as a sentence the run can carry.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The request as the seam returns it.
 *
 * The seam is host code, and host code may wait for something that never
 * comes — a person who does not answer, a cache that never answers. The
 * driver races that wait against the run's abort (see `raceWithAbort`), so a
 * seam that ignores the signal does not keep the run waiting.
 */
async function prepareThrough(
	host: HarnessHost,
	request: ProviderRequest,
	signal: AbortSignal,
): Promise<ProviderRequest> {
	if (!host.prepareRequest) return request;
	request = await host.prepareRequest(request, signal);
	return request;
}

/**
 * A wait that ends when the signal aborts.
 *
 * The work may never settle: a host that ignores the signal would leave the
 * driver waiting for it, and the run would never end. The abort wins the
 * race, and the work is left behind — a promise nobody awaits any more.
 */
async function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw aborted(signal);
	let onAbort: (() => void) | undefined;
	const stopped = new Promise<never>((_resolve, reject) => {
		onAbort = (): void => reject(aborted(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([work, stopped]);
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

/** The error an abort turns into. */
function aborted(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new Error("the run was cancelled");
}

/**
 * Whether a value is a provider request.
 *
 * The seam is host code, and host code can return nothing at all: a seam
 * that forgets its `return` hands the provider `undefined`. A request that
 * was never built is not one that can be performed, so the driver refuses it
 * the way it refuses a seam that throws.
 */
function isRequest(value: unknown): value is ProviderRequest {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		readonly model?: unknown;
		readonly messages?: unknown;
		readonly tools?: unknown;
	};
	return (
		typeof candidate.model === "string" &&
		Array.isArray(candidate.messages) &&
		Array.isArray(candidate.tools)
	);
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
