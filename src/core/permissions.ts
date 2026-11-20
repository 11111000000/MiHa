/**
 * The permission seam.
 *
 * There is no permission *engine* in MiHa: the policy belongs to the host, which
 * already knows what its user allowed. The core offers exactly one hook, and the hook
 * is where `allow`, `ask` and `deny` are decided (ADR 0002 D6).
 *
 * A blocked call is not a silent no-op — it becomes a tool result the model can read,
 * so the agent can tell the user what was refused and why.
 *
 * The hook is **synchronous** in v1. That keeps the dispatch planner a pure function
 * (ADR 0005 D24), which is what lets the laws be checked by substitution. A host that
 * must ask a human mid-run resolves that question before the run, or the run is
 * interrupted and restarted. Making the hook asynchronous is a planned extension, and
 * it costs the planner its purity — so it is a decision to make, not a detail.
 */

import type { ToolCallBlock, ToolDefinition } from "./tools.ts";

export interface BeforeToolCallContext {
	readonly call: ToolCallBlock;
	readonly tool: ToolDefinition;
	/** The validated arguments, before the hook may narrow them. */
	readonly args: Readonly<Record<string, unknown>>;
}

export interface BeforeToolCallResult {
	/** Refuse the call. The reason reaches the model. */
	readonly block?: boolean;
	readonly reason?: string;
	/** Replace the arguments. The replacement is **re-validated**. */
	readonly args?: Readonly<Record<string, unknown>>;
}

export type BeforeToolCall = (
	context: BeforeToolCallContext,
) => BeforeToolCallResult | undefined;
