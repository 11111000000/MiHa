/**
 * The page's entry: the document, and the worker.
 *
 * This is the thin layer that binds the page's half of the application to the
 * document: the worker is started, the panes are filled, the human is asked, and
 * the key is read from the field the person typed it into.
 *
 * **The key is read from the field and handed to the worker.** It is never
 * written to a file, never put in the bundle, and never sent anywhere but the
 * provider. The field holds it in memory, and the worker holds it in memory.
 */

import type { AgentEvent, JournalEntry } from "../../src/core/index.ts";
import { createWorkerHost } from "../../src/worker/host.ts";
import type { WorkerLike } from "../../src/worker/host.ts";
import { cancelFrame } from "./frames.ts";
import type { ApprovalRequest, HumanDecision } from "./frames.ts";
import { createPageApp } from "./page.ts";
import { capabilities, catalogue, seedDirectory } from "./tools.ts";
import type { Directory } from "./tools.ts";

/** The element with that id. The page says which ids it has; this finds them. */
const byId = (id: string): HTMLElement => {
	const element = document.getElementById(id);
	if (!element) throw new Error(`the page has no element "${id}"`);
	return element;
};

/** Adds a line to a pane. */
const line = (id: string, text: string): void => {
	const row = document.createElement("div");
	row.textContent = text;
	byId(id).append(row);
};

/** What the live view says about an event. */
const eventText = (event: AgentEvent): string => {
	switch (event.type) {
		case "message_update":
			return `delta ${event.providerEvent.type}`;
		case "message_start":
			return `message ${event.role} started`;
		case "message_end":
			return `message ${event.id} ended`;
		case "tool_execution_start":
			return `tool ${event.toolName} started`;
		case "tool_execution_update":
			return `tool ${event.toolName} reported`;
		case "tool_execution_end":
			return `tool ${event.toolName} ended${event.isError ? " (failed)" : ""}`;
		case "turn_end":
			return "turn ended";
		case "agent_end":
			return `run ended: ${event.outcome.kind}`;
		default:
			return event.type;
	}
};

/** What the journal pane says about an entry. */
const journalText = (entry: JournalEntry): string => {
	switch (entry.kind) {
		case "message":
			return `${entry.seq} message ${entry.role}`;
		case "tool_call":
			return `${entry.seq} call ${entry.name}`;
		case "tool_result":
			return `${entry.seq} result ${entry.name}${entry.isError ? " (failed)" : ""}`;
		case "block":
			return `${entry.seq} refused ${entry.name}: ${entry.reason}`;
		default:
			return `${entry.seq} ${entry.kind}`;
	}
};

/**
 * The page's directory.
 *
 * The example starts with two files, and the person may add their own: a browser
 * cannot read a directory of the disk without being given one.
 */
const files = new Map(seedDirectory().files);
const directory: Directory = { files };

/** The capabilities the bridge may reach: the page's own tools. */
const table = capabilities(directory);

/**
 * The worker.
 *
 * The URL is relative to the document, so the page and the worker are served from
 * the same place — which is what the build produces.
 *
 * **The worker is wrapped.** The harness's `WorkerLike` takes an `onmessage` of
 * `({ data: unknown }) => void`, and the DOM's `Worker` has an `onmessage` of
 * `(event: MessageEvent) => any` — and a property's parameter is checked
 * contravariantly, so the DOM's worker is not the harness's worker. The wrapper
 * says what the harness needs, and the two are joined here rather than in the
 * harness.
 */
const native = new Worker("./worker.js", { type: "module" });

const worker: WorkerLike = {
	postMessage(message: unknown) {
		native.postMessage(message);
	},
	terminate() {
		native.terminate();
	},
	onmessage: null,
};

native.onmessage = (event: MessageEvent): void => {
	worker.onmessage?.({ data: event.data });
};

/** The human is asked in a dialog, and the dialog answers the worker. */
const askHuman = (request: ApprovalRequest): Promise<HumanDecision> =>
	new Promise((resolve) => {
		byId("approve-tool").textContent = request.tool;
		byId("approve-args").textContent = JSON.stringify(request.args, null, 2);
		const dialog = byId("approve") as HTMLDialogElement;
		const settle = (decision: HumanDecision): void => {
			dialog.close();
			resolve(decision);
		};
		byId("approve-allow").onclick = (): void => settle({ allow: true });
		byId("approve-deny").onclick = (): void =>
			settle({ allow: false, reason: "the person refused the call" });
		dialog.showModal();
	});

let postToWorker: (frame: unknown) => void = () => {};

const app = createPageApp({
	catalogue: catalogue(),
	capabilities: table,
	askHuman,
	post: (frame) => postToWorker(frame),
	onEvent: (event) => line("events", eventText(event)),
	onJournal: (entry) => line("journal", journalText(entry)),
	onPeerJournal: (entry) => line("peer-journal", journalText(entry)),
	onPeerOutcome: (taskId, outcome) => line("peer-journal", `${taskId} ended: ${outcome.kind}`),
	onNote: (text) => line("events", text),
});

const host = createWorkerHost(worker, {
	capabilities: table,
	onEvent: (event) => line("events", eventText(event)),
	onOtherFrame: (frame) => {
		app.handle(frame);
	},
});
postToWorker = (frame) => host.channel.post(frame);

/** The key, as the person typed it. It is read, and it is not kept anywhere else. */
const keyOf = (): string => (byId("key") as HTMLInputElement).value;

byId("run").onclick = (): void => {
	const key = keyOf();
	if (key === "") {
		byId("status").textContent = "the provider's key is needed";
		return;
	}
	byId("status").textContent = "running";
	app.run((byId("prompt") as HTMLTextAreaElement).value, key);
};

byId("cancel").onclick = (): void => {
	postToWorker(cancelFrame());
};

byId("peer-offer").onclick = (): void => {
	const key = keyOf();
	if (key === "") {
		byId("status").textContent = "the provider's key is needed";
		return;
	}
	const task = (byId("peer-task") as HTMLInputElement).value;
	app.offerToPeer(`t${Date.now()}`, task, key);
};

/** Adds the files the person picked to the page's directory. */
const addFiles = async (picked: FileList | null): Promise<void> => {
	if (!picked) return;
	for (const file of Array.from(picked)) {
		files.set(file.name, await file.text());
	}
	byId("status").textContent = `${files.size} files in the directory`;
};

(byId("files") as HTMLInputElement).onchange = (event): void => {
	const input = event.target as HTMLInputElement;
	void addFiles(input.files);
};
