/**
 * The tool-call tracker.
 *
 * A provider streams the calls of one assistant message **in parallel**: each call
 * has a stream index, and the fragments of their arguments arrive interleaved. The
 * tracker turns that stream back into per-call events.
 *
 * Two rules, and they are the whole difficulty:
 *
 * - **Correlation is by index, not by id.** The id of a call may arrive in a later
 *   fragment, but its index is fixed from the first fragment. A tracker that
 *   correlates by id loses fragments.
 * - **A call starts when it is identifiable.** The tracker waits for both the id and
 *   the name, because the id is what the result must reference and the name is what
 *   decides which tool runs. Fragments that arrive before that are held and emitted
 *   with the start, in order.
 */

import type { ProviderEvent } from "../core/events.ts";

export interface ToolCallDelta {
	/** The provider's index for this call within the assistant message. */
	readonly index: number;
	readonly id?: string;
	readonly name?: string;
	readonly argumentsDelta?: string;
}

interface Entry {
	readonly index: number;
	id: string | undefined;
	name: string | undefined;
	argumentsText: string;
	started: boolean;
	/** Fragments that arrived before the call could be started. */
	readonly held: string[];
}

export class ToolCallTracker {
	#byIndex = new Map<number, Entry>();

	/** Feeds one fragment and returns the events it produced. */
	feed(delta: ToolCallDelta): readonly ProviderEvent[] {
		const events: ProviderEvent[] = [];

		let entry = this.#byIndex.get(delta.index);
		if (!entry) {
			entry = { index: delta.index, id: undefined, name: undefined, argumentsText: "", started: false, held: [] };
			this.#byIndex.set(delta.index, entry);
		}

		let id = entry.id;
		if (delta.id !== undefined) {
			id = delta.id;
			entry.id = id;
		}
		let name = entry.name;
		if (delta.name !== undefined) {
			name = delta.name;
			entry.name = name;
		}
		if (delta.argumentsDelta !== undefined && delta.argumentsDelta !== "") {
			entry.argumentsText += delta.argumentsDelta;
			entry.held.push(delta.argumentsDelta);
		}

		if (!entry.started) {
			if (id === undefined || name === undefined) return events;
			entry.started = true;
			events.push({ type: "tool_call_start", id, name });
		}
		if (id === undefined) return events;

		for (const fragment of entry.held) {
			events.push({ type: "tool_arguments_delta", id, delta: fragment });
		}
		entry.held.length = 0;

		return events;
	}

	/** The calls seen so far, in the order their indices first appeared. */
	get calls(): readonly { readonly id: string; readonly name: string; readonly argumentsText: string }[] {
		const calls: { id: string; name: string; argumentsText: string }[] = [];
		for (const entry of this.#byIndex.values()) {
			if (entry.id === undefined || entry.name === undefined) continue;
			calls.push({ id: entry.id, name: entry.name, argumentsText: entry.argumentsText });
		}
		return calls;
	}

	/**
	 * The indexes of the calls that never identified themselves.
	 *
	 * A call is identified by its id and its name: the id is what the answer
	 * must reference, and the name is what says which tool runs. A call that
	 * never says both cannot be performed — and it cannot be dropped either,
	 * because the model is waiting for an answer to it. So the caller reports
	 * it.
	 */
	get unidentified(): readonly number[] {
		const indexes: number[] = [];
		for (const entry of this.#byIndex.values()) {
			if (entry.id === undefined || entry.name === undefined) indexes.push(entry.index);
		}
		return indexes;
	}
}
