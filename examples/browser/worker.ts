/**
 * The worker: the harness, running.
 *
 * The placement is the architecture's: the **harness is in the worker**, and the
 * **application's interface is in the page**. The worker cannot reach the DOM, the
 * storage or the page's files, so everything the agent needs from the application
 * goes across the capability bridge — one call per tool call — and everything the
 * application needs to show goes back over the same channel.
 *
 * Four things live here:
 *
 * - the **run**: the harness, the provider, and the approve seam;
 * - the **tools**: built from the catalogue the page sent, and each one a call
 *   across the bridge;
 * - the **journal**: every entry the run writes, handed to the page as it is
 *   written;
 * - the **peer link**: a task the page offers, and the peer's journal coming back.
 *
 * The provider is injected, so the example's own tests can answer from a script
 * instead of from a network. The browser's entry passes the MiniMax adapter.
 */

import {
	runAgent,
	toolRegistry,
	userMessage,
	type ApproveContext,
	type ApproveDecision,
	type HarnessConfig,
	type HarnessHost,
	type ToolDefinition,
} from "../../src/core/index.ts";
import { delegate, receive } from "../../src/exchange/index.ts";
import type { ProviderFn } from "../../src/llm/index.ts";
import { createCapabilityClient } from "../../src/worker/bridge.ts";
import type { Channel } from "../../src/worker/protocol.ts";
import {
	approveFrame,
	eventFrame,
	isDecisionFrame,
	isCancelFrame,
	isPeerOfferFrame,
	isRunFrame,
	journalFrame,
	noteFrame,
	peerJournalFrame,
	peerOutcomeFrame,
	type HumanDecision,
	type OfferedTool,
	type PeerOfferFrame,
	type RunFrame,
} from "./frames.ts";
import { createPortPair } from "./peer.ts";

export interface WorkerOptions {
	/**
	 * The provider: the key in, the adapter out.
	 *
	 * The key arrives with the run, in memory, and the adapter is built from it.
	 * The key is never written anywhere.
	 */
	readonly provider: (apiKey: string) => ProviderFn;
	readonly model?: string;
	/** What the page's agent is told. */
	readonly system?: string;
	/** What the peer's agent is told. The peer is told something else. */
	readonly peerSystem?: string;
	/**
	 * The provider's own knobs, handed to the wire verbatim.
	 *
	 * The bag holds what the provider understands — MiniMax's `reasoning_split` and
	 * `thinking`, for instance — and it does not get to say which model answers or
	 * what the model is told.
	 */
	readonly wireOptions?: Readonly<Record<string, unknown>>;
	readonly turnLimit?: number;
}

export interface WorkerApp {
	/** Takes a frame the page sent. Says whether it was one of ours. */
	handle(frame: unknown): boolean;
}

/** The model the example asks for. */
const MODEL = "MiniMax-M3";

/** What the page's agent is told. */
const SYSTEM =
	"you are the agent of a browser application. the application owns the files you may read, " +
	"and every call you make is shown to the person who uses it before it runs.";

/** What the peer's agent is told. It is a different agent, in a different place. */
const PEER_SYSTEM =
	"you are the agent of the peer: you were given a task, you run it with your own " +
	"tools, and you report what happened.";

/**
 * The peer's own tool.
 *
 * The peer does not get the page's tools: a peer gets a task, never a handle on
 * the other side's tools (ADR 0007 D41).
 */
const repeat: ToolDefinition = {
	name: "repeat",
	description: "repeats what it is told",
	parameters: {
		kind: "object",
		properties: { text: { kind: "string" } },
		required: ["text"],
		additional: false,
	},
	execute: async (_call, args) => ({
		content: [{ type: "text", text: textOf(args.text) }],
	}),
};

/** A value as the model reads it. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The worker's half of the application.
 *
 * The channel is the one the harness's bridge uses, so the capability calls and
 * the application's own frames travel on the same wire — and the bridge tells
 * them apart.
 */
export function createWorkerApp(channel: Channel, options: WorkerOptions): WorkerApp {
	const model = options.model ?? MODEL;
	const system = options.system ?? SYSTEM;
	const peerSystem = options.peerSystem ?? PEER_SYSTEM;

	/** The questions the human has not answered yet. */
	const pending = new Map<string, (decision: HumanDecision) => void>();
	let counter = 0;

	/** The run in flight, so that the page may stop it. */
	let controller: AbortController | undefined;

	/** The two ends of the peer link. */
	const ports = createPortPair();

	const client = createCapabilityClient(channel, {
		onOtherFrame: (frame) => {
			handle(frame);
		},
	});

	/**
	 * The tools the agent may call.
	 *
	 * One tool per entry of the catalogue the page sent, and each one reaches the
	 * page's capability of the same name through the bridge. The agent's tool list
	 * is therefore the page's list — nothing more.
	 */
	const toolsOf = (offered: readonly OfferedTool[]): ToolDefinition[] =>
		offered.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (_call, args) => {
				// The capability runs in the page. The worker has no directory of its
				// own, and it never gets one: it asks, and the page answers.
				const value = await client.call(tool.name, args);
				return { content: [{ type: "text", text: textOf(value) }] };
			},
		}));

	/**
	 * The permission seam: the worker asks the page, and the page asks the human.
	 *
	 * The seam is asynchronous because the human is (ADR 0008 D44). A refusal is
	 * not an error: it is the model's answer, and the run continues.
	 */
	const ask = async (context: ApproveContext): Promise<ApproveDecision> => {
		const id = `q${(counter += 1)}`;
		const answer = new Promise<HumanDecision>((resolve) => {
			pending.set(id, resolve);
		});
		channel.post(approveFrame(id, context.tool.name, context.args));
		const decision = await answer;
		pending.delete(id);
		if (decision.allow) return { kind: "allow" };
		return { kind: "deny", reason: decision.reason ?? "the person refused the call" };
	};

	/** Runs the agent on what the page asked for. */
	const run = async (frame: RunFrame): Promise<void> => {
		if (controller !== undefined) {
			// One run at a time: the worker's realm holds one conversation, and a
			// second run would take the first one's stop button away.
			channel.post(noteFrame("a run is already in flight"));
			return;
		}
		const config: HarnessConfig = {
			model,
			system,
			tools: toolRegistry(toolsOf(frame.catalogue)),
			...(options.wireOptions === undefined ? {} : { options: options.wireOptions }),
			...(options.turnLimit === undefined ? {} : { turnLimit: options.turnLimit }),
		};
		const host: HarnessHost = {
			callProvider: options.provider(frame.apiKey),
			// The journal leaves the worker as it is written: the page keeps it.
			append: (entry) => channel.post(journalFrame(entry)),
			approve: (context) => ask(context),
		};

		controller = new AbortController();
		try {
			const stream = runAgent(config, host, {
				message: userMessage(frame.text),
				signal: controller.signal,
			});
			for await (const event of stream) channel.post(eventFrame(event));
		} finally {
			controller = undefined;
		}
	};

	/**
	 * Offers a task to the peer, and reports what the peer did.
	 *
	 * The peer runs the task with **its own** tools and its own provider, and its
	 * journal entries come back to the page as they are written.
	 */
	const offerToPeer = async (frame: PeerOfferFrame): Promise<void> => {
		const peer = receive({
			port: ports.there,
			taskId: frame.taskId,
			config: {
				model,
				system: peerSystem,
				tools: toolRegistry([repeat]),
			},
			host: { callProvider: options.provider(frame.apiKey) },
		});

		const task = delegate({
			port: ports.here,
			taskId: frame.taskId,
			task: frame.task,
			...(frame.context === undefined ? {} : { context: frame.context }),
		});

		for await (const entry of task.events) channel.post(peerJournalFrame(entry));
		const outcome = await task.outcome;
		channel.post(peerOutcomeFrame(frame.taskId, outcome));
		// The receiving side's handle is kept for the length of the task: it is
		// what holds the listener on the port, and dropping it would leave the
		// peer's task unheard.
		void peer;
	};

	/** Stops the run, and answers whatever the human was asked. */
	const cancel = (): void => {
		controller?.abort();
		for (const [, resolve] of pending) {
			resolve({ allow: false, reason: "the run was cancelled" });
		}
		pending.clear();
	};

	/** Takes a frame the page sent. */
	function handle(frame: unknown): boolean {
		if (isRunFrame(frame)) {
			// A run that fails is said out loud: the page shows it, and nobody is
			// left waiting for a run that is over.
			void run(frame).catch((error: unknown) => {
				channel.post(noteFrame(`the run failed: ${messageOf(error)}`));
			});
			return true;
		}
		if (isDecisionFrame(frame)) {
			const resolve = pending.get(frame.id);
			if (resolve) {
				resolve({
					allow: frame.allow,
					...(frame.reason === undefined ? {} : { reason: frame.reason }),
				});
			}
			return true;
		}
		if (isPeerOfferFrame(frame)) {
			void offerToPeer(frame).catch((error: unknown) => {
				channel.post(noteFrame(`the task could not be offered: ${messageOf(error)}`));
			});
			return true;
		}
		if (isCancelFrame(frame)) {
			cancel();
			return true;
		}
		return false;
	}

	return { handle };
}
