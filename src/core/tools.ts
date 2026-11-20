/**
 * The tool contract, the registry, and the dispatch plan.
 *
 * Four fields and two optional ones. The parameters are **our dialect**
 * (ADR 0004 D20), not JSON Schema, and the dialect converts to the provider's JSON
 * Schema on the way out.
 *
 * Two rules the contract carries:
 *
 * - **Arguments are validated by the core, before dispatch.** A tool never parses its
 *   own arguments — that is how the fourth tool forgets.
 * - **A tool that fails is a result.** It may throw; the core turns the throw into a
 *   result with `isError`. It may also return `isError` directly, and then `details`
 *   survives for the interface, which a throw would discard (law M3).
 *
 * The dispatch plan is the core's decision, not the host's: the core says which calls
 * can run and how they group, the host runs them.
 */

import { validate, type ToolSchema } from "../schema/dialect.ts";
import { parseJson } from "./json.ts";
import { text, toolResultMessage, type ToolCallBlock, type ToolResult, type ToolResultMessage } from "./messages.ts";
import type { BeforeToolCall } from "./permissions.ts";

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly parameters: ToolSchema;
	/**
	 * "exclusive" tools never run alongside another exclusive tool. They still run
	 * alongside shared ones — exclusive means *do not interleave with another
	 * exclusive*, not *serialise the turn* (policy T1).
	 */
	readonly concurrency?: "shared" | "exclusive";
	readonly execute: ToolExecute;
}

export type ToolExecute = (
	call: ToolCallBlock,
	signal: AbortSignal,
	report: (partial: ToolResult) => void,
) => Promise<ToolResult>;

export type ToolRegistry = ReadonlyMap<string, ToolDefinition>;

/** Builds a registry, refusing two tools with the same name. */
export function toolRegistry(definitions: readonly ToolDefinition[]): ToolRegistry {
	const registry = new Map<string, ToolDefinition>();
	for (const definition of definitions) {
		if (registry.has(definition.name)) {
			throw new Error(`duplicate tool name: ${definition.name}`);
		}
		registry.set(definition.name, definition);
	}
	return registry;
}

/** One call, ready to run: the call itself and its validated arguments. */
export interface ToolCallPlan {
	readonly call: ToolCallBlock;
	readonly args: Readonly<Record<string, unknown>>;
}

/**
 * The plan for one batch.
 *
 * `groups` execute in order; within a group the calls run in parallel. `rejections`
 * are the calls that cannot run, already turned into results.
 *
 * **Law M1**: every call of the batch appears exactly once, in `groups` or in
 * `rejections`. Nothing is left unanswered.
 */
export interface ToolPlan {
	readonly turn: number;
	readonly groups: readonly (readonly ToolCallPlan[])[];
	readonly rejections: readonly ToolResultMessage[];
}

/**
 * Plans the execution of a batch of calls.
 *
 * A call is rejected when the tool is unknown, when its arguments do not parse, when
 * they do not validate against the tool's dialect, or when the host's permission hook
 * refuses it. A rejected call never runs (law M2 for the truncated case) and always
 * produces a result (law M1).
 */
export function planDispatch(
	calls: readonly ToolCallBlock[],
	registry: ToolRegistry,
	turn: number,
	beforeToolCall?: BeforeToolCall,
): ToolPlan {
	const groups: ToolCallPlan[][] = [];
	const rejections: ToolResultMessage[] = [];
	let shared: ToolCallPlan[] = [];

	for (const call of calls) {
		const tool = registry.get(call.name);
		if (!tool) {
			rejections.push(reject(call, `unknown tool "${call.name}"`));
			continue;
		}

		const parsed = parseJson(call.argumentsText);
		if (!parsed.ok) {
			rejections.push(reject(call, `arguments are not valid JSON: ${parsed.error}`));
			continue;
		}
		if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
			rejections.push(reject(call, "arguments must be a JSON object"));
			continue;
		}

		const validated = validate(tool.parameters, parsed.value);
		if (!validated.ok) {
			rejections.push(reject(call, `${validated.error.path || "/"}: ${validated.error.message}`));
			continue;
		}
		let args = validated.value as Record<string, unknown>;

		if (beforeToolCall) {
			const decision = beforeToolCall({ call, tool, args });
			if (decision?.block) {
				rejections.push(reject(call, decision.reason ?? "blocked by the host"));
				continue;
			}
			if (decision?.args) {
				const rewritten = validate(tool.parameters, decision.args);
				if (!rewritten.ok) {
					rejections.push(
						reject(call, `host rewrote the arguments badly — ${rewritten.error.path || "/"}: ${rewritten.error.message}`),
					);
					continue;
				}
				args = rewritten.value as Record<string, unknown>;
			}
		}

		const plan: ToolCallPlan = { call, args };
		if (tool.concurrency === "exclusive") {
			if (shared.length > 0) {
				groups.push(shared);
				shared = [];
			}
			groups.push([plan]);
			continue;
		}
		shared.push(plan);
	}

	if (shared.length > 0) groups.push(shared);

	return { turn, groups, rejections };
}

/** A call that cannot run, as a result the model can read (law M3). */
export function reject(call: ToolCallBlock, reason: string): ToolResultMessage {
	return toolResultMessage(call.id, call.name, [text(reason)], true);
}

/** A tool's own failure, turned into a result (law M3). */
export function failureResult(call: ToolCallBlock, error: unknown): ToolResultMessage {
	const message = error instanceof Error ? error.message : String(error);
	return toolResultMessage(call.id, call.name, [text(message)], true);
}

/** A tool's success, turned into a result. */
export function successResult(call: ToolCallBlock, result: ToolResult): ToolResultMessage {
	return toolResultMessage(
		call.id,
		call.name,
		result.content,
		result.isError === true,
		result.details,
	);
}
