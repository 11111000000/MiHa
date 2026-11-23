/**
 * The cassette.
 *
 * The trace is the journal — there is no second format (ADR 0008 D46). What the
 * journal cannot hold is the provider's **responses**: the journal holds what the
 * model said and what the tools answered, never the stream that arrived between
 * them. The cassette holds that, and nothing else, keyed by the request that asked
 * for it.
 *
 * Replay is the same run with the cassette in place of the provider: the harness
 * asks the same questions, and the cassette answers them with what the provider
 * answered the first time. A request the recording does not hold is a
 * **divergence**, and it is reported — never answered with an empty stream, which
 * would look like a run that had nothing to say.
 */

import type { ProviderEvent } from "../core/events.ts";
import type { HarnessHost } from "../core/loop.ts";
import type { ProviderRequest } from "../core/run.ts";
import type {
	AgentMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCallBlock,
} from "../core/messages.ts";

/** The format of a cassette. A later format bumps it. */
export const CASSETTE_VERSION = 1;

/**
 * The provider's responses, keyed by the request that asked for them.
 *
 * Nothing else is here. The journal holds the run, and a copy of the run inside the
 * cassette would be a second trace that could disagree with the first.
 */
export interface Cassette {
	readonly version: number;
	/**
	 * The recorded responses, keyed by the request that asked for them.
	 *
	 * A key may hold **several** answers: a run may ask the same question twice, and
	 * the replay must answer each of them with what it was answered the first time —
	 * the first occurrence takes the first recording, the second the second. One
	 * answer per key would make the second run replay to the first run's journal.
	 */
	readonly responses: Readonly<Record<string, readonly (readonly ProviderEvent[])[]>>;
}

/** A request the cassette could not answer. */
export interface Divergence {
	/** The key the request files under — its name in the recording. */
	readonly key: string;
	/** The request itself, so the reader can see what was asked. */
	readonly request: ProviderRequest;
	/** Why the cassette could not answer it. */
	readonly reason: string;
}

/** A provider that remembers what it answered. */
export interface Recorder {
	/** The provider to hand to the host. */
	readonly callProvider: HarnessHost["callProvider"];
	/** What has been recorded so far. */
	readonly cassette: Cassette;
}

/** A provider that answers from a recording. */
export interface Replay {
	/** The provider to hand to the host. */
	readonly callProvider: HarnessHost["callProvider"];
	/** The requests the cassette could not answer, in the order they came. */
	readonly divergences: readonly Divergence[];
}

/**
 * Wraps a provider and remembers what it answered.
 *
 * Each call is recorded under the key of the request that asked for it, with the
 * events the provider produced. The entry is claimed when the call starts and
 * filled as the events arrive, because the driver stops reading a stream as soon
 * as the run is over — a response recorded only at the end would be lost exactly
 * when it matters most. A stream that *broke* is not an answer, and the cassette
 * says nothing about it.
 */
export function record(provider: HarnessHost["callProvider"]): Recorder {
	const responses = new Map<string, (readonly ProviderEvent[])[]>();
	return {
		callProvider: async function* (request, signal) {
			const key = requestKey(request);
			const events: ProviderEvent[] = [];
			const recorded = responses.get(key) ?? [];
			recorded.push(events);
			responses.set(key, recorded);
			try {
				for await (const event of provider(request, signal)) {
					events.push(event);
					yield event;
				}
			} catch (error) {
				// A call that broke is not an answer: the recording says nothing.
				const index = recorded.indexOf(events);
				if (index !== -1) recorded.splice(index, 1);
				if (recorded.length === 0) responses.delete(key);
				throw error;
			}
		},
		get cassette(): Cassette {
			// A snapshot: the cassette is a value, not a view of a running recording.
			return {
				version: CASSETTE_VERSION,
				responses: Object.fromEntries(
					[...responses].map(([key, recorded]) => [key, recorded.map((events) => [...events])]),
				),
			};
		},
	};
}

/**
 * Answers from a recording.
 *
 * The request that arrives is keyed the same way the recorded one was, and the
 * recorded events are given back unchanged. A request the recording does not hold
 * is a divergence: it is reported as one, naming the request, and the run is told
 * through the provider's own error path (law M4) — so the divergence ends up in
 * the journal, which is the trace.
 */
export function replay(cassette: Cassette): Replay {
	const divergences: Divergence[] = [];
	// How many times each key was asked in this replay: the n-th ask takes the n-th
	// recording, so a run that asked twice replays both of its answers.
	const asked = new Map<string, number>();
	return {
		callProvider: async function* (request) {
			const key = requestKey(request);
			const occurrence = asked.get(key) ?? 0;
			asked.set(key, occurrence + 1);
			const recorded = cassette.responses[key]?.[occurrence];
			if (recorded === undefined) {
				const divergence: Divergence = {
					key,
					request,
					reason:
						cassette.version !== CASSETTE_VERSION
							? `the cassette is of version ${String(cassette.version)}, and this harness speaks version ${String(CASSETTE_VERSION)}`
							: "the cassette holds no response for this request",
				};
				divergences.push(divergence);
				const failure: ProviderEvent = {
					type: "error",
					message: `divergence: ${divergence.reason}: request ${key} (${describe(request)})`,
				};
				yield failure;
				return;
			}
			for (const event of recorded) yield event;
		},
		get divergences(): readonly Divergence[] {
			return [...divergences];
		},
	};
}

/**
 * The key of a request: the identity it is filed under in a cassette.
 *
 * The same request always has the same key, and two requests that differ in what
 * the provider is asked have different keys. The key is a hash and not the request
 * itself: a cassette that held the request would hold a second copy of the
 * transcript, which is exactly what the trace must not be.
 */
export function requestKey(request: ProviderRequest): string {
	return hash(canonical(requestForm(request)));
}

/**
 * The request as the provider is asked: the fields that decide the answer.
 *
 * What the provider answered last time is not part of it — the usage and the stop
 * reason of the previous turn — and neither is what the interface showed. What is
 * asked is the model, the system prompt, the messages, the tools and the options.
 */
function requestForm(request: ProviderRequest): unknown {
	return {
		model: request.model,
		system: request.system,
		messages: request.messages.map(messageForm),
		tools: request.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
		...(request.options === undefined ? {} : { options: request.options }),
	};
}

/** A message as the provider is asked: its role, and what it says. */
function messageForm(message: AgentMessage): unknown {
	if (message.role === "user") return { role: "user", content: message.content };
	if (message.role === "assistant") return { role: "assistant", content: message.content };
	return {
		role: "toolResult",
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		isError: message.isError,
		content: message.content,
	};
}

/**
 * The canonical form of a value: JSON, with every object's keys sorted.
 *
 * Two values that differ only in the order of their keys have the same canonical
 * form, so a key does not depend on how the host happened to build the request.
 * `JSON.stringify` would make it depend on the insertion order, and the same
 * request built twice would be two requests.
 */
function canonical(value: unknown): string {
	if (value === null) return "z:null";
	if (typeof value === "string") return `s:${JSON.stringify(value)}`;
	if (typeof value === "number") {
		// A number and its name are different things: `NaN` and `"NaN"` must not
		// file under the same key, or the replay answers with the wrong recording
		// and reports no divergence.
		return `n:${Number.isFinite(value) ? String(value) : String(value)}`;
	}
	if (typeof value === "boolean") return value ? "b:true" : "b:false";
	if (value === undefined) return "u:undefined";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(byName);
		return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`;
	}
	return `x:${JSON.stringify(String(value))}`;
}

/** Sorts entries by name, so that an object's order never reaches the key. */
function byName([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

const encoder = new TextEncoder();

/**
 * The key: two 32-bit hashes over the canonical form, as sixteen hex digits.
 *
 * No crypto and no dependency: FNV-1a and djb2 are two old, well-understood
 * hashes, and two of them make 64 bits. A cassette holds thousands of requests at
 * most, and at that size a collision is not a thing that happens.
 */
function hash(text: string): string {
	const bytes = encoder.encode(text);
	let fnv = 0x811c9dc5;
	let djb = 5381;
	for (const byte of bytes) {
		fnv = Math.imul(fnv ^ byte, 0x01000193) >>> 0;
		djb = (Math.imul(djb, 33) + byte) >>> 0;
	}
	return `${fnv.toString(16).padStart(8, "0")}${djb.toString(16).padStart(8, "0")}`;
}

/** Names a request in words a reader can act on. */
function describe(request: ProviderRequest): string {
	const last = request.messages[request.messages.length - 1];
	const said = last === undefined ? "no message" : `${last.role}: ${headline(last)}`;
	const count = request.messages.length;
	return `model ${request.model}, ${count} message${count === 1 ? "" : "s"}, last ${said}`;
}

/** The text of a message, as the model would read it. */
function headline(message: AgentMessage): string {
	if (message.role === "user") {
		return typeof message.content === "string" ? message.content : blocksText(message.content);
	}
	return blocksText(message.content);
}

/** The text of a message's blocks. */
function blocksText(
	blocks: readonly (TextContent | ImageContent | ThinkingContent | ToolCallBlock)[],
): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "thinking") parts.push(block.thinking);
	}
	return parts.join(" ");
}
