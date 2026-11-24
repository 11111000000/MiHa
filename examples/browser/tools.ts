/**
 * The tools the page offers the agent.
 *
 * Three of them, and each one earns its place:
 *
 * - `read_file` — reads a file of the page's directory;
 * - `list_dir` — says what the directory holds;
 * - `echo` — says back what it was told, so that a run can be watched from end to
 *   end without touching anything.
 *
 * **The page owns this catalogue.** The worker is told what the tools are and
 * builds them; it never invents one. That is what makes "the agent called a tool
 * the page never offered" impossible rather than merely unlikely: the worker's
 * tool list *is* the list the page sent.
 *
 * The tools are the page's own, so they run in the page — the worker reaches them
 * through the capability bridge, one call per tool call.
 */

import type { CapabilityFn } from "../../src/worker/protocol.ts";
import type { OfferedTool } from "./frames.ts";

/**
 * The directory the tools work on.
 *
 * A browser cannot read a directory of the disk without being given one, so the
 * page holds the files it was given: the ones the user picked, and the ones the
 * example starts with.
 */
export interface Directory {
	readonly files: ReadonlyMap<string, string>;
}

/** The directory the example starts with. */
export function seedDirectory(): Directory {
	return {
		files: new Map([
			["notes.txt", "the harness runs in a worker, and the page is the interface.\n"],
			["adr-0008.txt", "one permission seam, and it is asynchronous.\n"],
		]),
	};
}

/**
 * The catalogue the page offers.
 *
 * The parameters are the harness's own dialect, so the worker does not have to
 * translate them and the model receives the JSON Schema the dialect converts to.
 */
export function catalogue(): readonly OfferedTool[] {
	return [
		{
			name: "read_file",
			description: "reads a file of the page's directory",
			parameters: {
				kind: "object",
				properties: { path: { kind: "string" } },
				required: ["path"],
				additional: false,
			},
		},
		{
			name: "list_dir",
			description: "lists the files of the page's directory",
			parameters: { kind: "object", properties: {}, additional: false },
		},
		{
			name: "echo",
			description: "says back the text it was given",
			parameters: {
				kind: "object",
				properties: { text: { kind: "string" } },
				required: ["text"],
				additional: false,
			},
		},
	];
}

/**
 * A string argument of a tool call.
 *
 * The core validated the arguments before the call was planned, so the argument is
 * there — but a capability is reached through the bridge, and the bridge carries
 * whatever it was given. A capability that cannot read its argument says so.
 */
function textArg(args: unknown, name: string): string {
	if (typeof args !== "object" || args === null) throw new Error(`the arguments carry no "${name}"`);
	const value = (args as Record<string, unknown>)[name];
	if (typeof value !== "string") throw new Error(`the arguments carry no "${name}"`);
	return value;
}

/**
 * The page's capabilities — the tools, as the bridge reaches them.
 *
 * The name of a capability is the name of the tool: the worker calls the tool by
 * the name the page gave it, so there is nothing to map and nothing to get wrong.
 */
export function capabilities(directory: Directory): Readonly<Record<string, CapabilityFn>> {
	const readFile: CapabilityFn = (args) => {
		const path = textArg(args, "path");
		const content = directory.files.get(path);
		if (content === undefined) throw new Error(`there is no file "${path}" in the directory`);
		return content;
	};

	const listDir: CapabilityFn = () => {
		const names = [...directory.files.keys()].sort();
		return names.length === 0 ? "the directory is empty" : names.join("\n");
	};

	const echo: CapabilityFn = (args) => textArg(args, "text");

	return { read_file: readFile, list_dir: listDir, echo };
}
