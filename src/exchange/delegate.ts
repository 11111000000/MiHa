/**
 * The delegating side of the exchange.
 *
 * The frontend agent hands a task to the backend agent. While the task runs, the peer
 * may call back the tools this side owns — that is what makes the exchange more than
 * a request and an answer.
 *
 * A peer's call goes through the **same dispatch** as a local one, so the arguments are
 * validated against the tool's dialect and the host's permission hook applies. A peer
 * must not be able to do what the host would not allow.
 */

import type { AgentEvent, Outcome } from "../core/events.ts";
import type { ToolResultMessage } from "../core/messages.ts";
import type { BeforeToolCall } from "../core/permissions.ts";
import { planDispatch, toolRegistry, type ToolRegistry } from "../core/tools.ts";
import { toolCall } from "../core/messages.ts";
import { AgentEventQueue } from "./queue.ts";
import { isExchangeFrame, type ExchangeFrame, type ExchangePort } from "./protocol.ts";

export interface DelegateOptions {
	readonly port: ExchangePort;
	readonly taskId: string;
	readonly task: string;
	readonly context?: string;
	/** The tools the peer may call, and how to run them. */
	readonly tools?: ToolRegistry;
	readonly beforeToolCall?: BeforeToolCall;
}

export interface DelegatedTask {
	/** The peer's events, in the order they were sent. */
	readonly events: AsyncIterable<AgentEvent>;
	/** How the task ended. */
	readonly outcome: Promise<Outcome>;
	/** Asks the peer to stop. */
	cancel(): void;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function rejectionText(rejection: ToolResultMessage | undefined): string {
	const first = rejection?.content[0];
	if (first && first.type === "text") return first.text;
	return "the call cannot run";
}

export function delegate(options: DelegateOptions): DelegatedTask {
	const { port, taskId, task, context, tools, beforeToolCall } = options;

	const events = new AgentEventQueue();
	let settle: ((outcome: Outcome) => void) | undefined;
	const outcome = new Promise<Outcome>((resolve) => {
		settle = resolve;
	});

	const finish = (result: Outcome): void => {
		settle?.(result);
		settle = undefined;
		events.close();
	};

	port.onMessage((message) => {
		if (!isExchangeFrame(message)) return;
		const frame: ExchangeFrame = message;
		if (frame.taskId !== taskId) return;

		switch (frame.kind) {
			case "offer":
			case "accept":
			case "answer":
			case "cancel":
				return;
			case "refuse":
				finish({ kind: "failed", error: frame.reason });
				return;
			case "event":
				events.push(frame.event);
				return;
			case "result":
				finish(frame.outcome);
				return;
			case "call":
				void answerCall(frame.callId, frame.tool, frame.args);
				return;
		}
	});

	/**
	 * Runs a call the peer made, through the host's own dispatch.
	 *
	 * The arguments travel as a JSON string, because that is what a tool call is, and
	 * the dispatch validates them against the tool's dialect and applies the
	 * permission hook — exactly as it does for a local call.
	 */
	const answerCall = async (callId: string, tool: string, args: unknown): Promise<void> => {
		let argumentsText: string;
		try {
			argumentsText = JSON.stringify(args ?? {});
		} catch (error) {
			port.post({
				kind: "answer",
				taskId,
				callId,
				ok: false,
				error: `the arguments cannot be sent: ${messageOf(error)}`,
			});
			return;
		}

		if (!tools) {
			port.post({ kind: "answer", taskId, callId, ok: false, error: "this side offers no tools" });
			return;
		}

		const call = toolCall(callId, tool, argumentsText);
		const plan = planDispatch([call], tools, 0, beforeToolCall);
		const [entry] = plan.groups.flat();
		if (!entry) {
			port.post({
				kind: "answer",
				taskId,
				callId,
				ok: false,
				error: rejectionText(plan.rejections[0]),
			});
			return;
		}

		try {
			const result = await entry.tool.execute(entry.call, new AbortController().signal, () => {});
			port.post({ kind: "answer", taskId, callId, ok: true, result });
		} catch (error) {
			port.post({ kind: "answer", taskId, callId, ok: false, error: messageOf(error) });
		}
	};

	const offer: ExchangeFrame = {
		kind: "offer",
		taskId,
		task,
		...(context === undefined ? {} : { context }),
		...(tools === undefined ? {} : { tools: [...tools.keys()] }),
	};
	port.post(offer);

	return {
		events,
		outcome,
		cancel(): void {
			port.post({ kind: "cancel", taskId });
		},
	};
}

export { toolRegistry };
