import { describe, expect, test } from "bun:test";
import {
	contextMessages,
	foldContext,
	initialContextState,
	projectContext,
	JOURNAL_VERSION,
	type JournalBody,
	type JournalEntry,
} from "../src/core/journal.ts";
import { emptyUsage } from "../src/core/messages.ts";
import type { AgentMessage } from "../src/core/messages.ts";

/**
 * The journal (ADR 0006 D39, ADR 0008 D45): one append-only log of durable events,
 * and the model's context as a fold over it.
 *
 * What the tests pin down:
 *
 *   - the entry kinds and the envelope (a monotonic sequence, one version)
 *   - the fold: a tool call joins the assistant message that asked for it
 *   - a block is the model's answer to a refusal, not a hole
 *   - a compaction collapses a range and keeps the rest
 *   - a change replaces an earlier entry's model-facing view, the history untouched
 *   - the replay law: fold(replay(log)) ≡ fold(log)
 */

function entry(seq: number, body: JournalBody): JournalEntry {
	return { ...body, seq, version: JOURNAL_VERSION } as JournalEntry;
}

const user = (seq: number, text: string): JournalEntry =>
	entry(seq, { kind: "message", role: "user", content: text });

const assistant = (seq: number, text: string): JournalEntry =>
	entry(seq, {
		kind: "message",
		role: "assistant",
		content: [{ type: "text", text }],
		usage: emptyUsage,
		stopReason: "toolUse",
	});

const call = (seq: number, id: string, name: string): JournalEntry =>
	entry(seq, { kind: "tool_call", callId: id, name, argumentsText: "{}" });

const result = (seq: number, id: string, name: string, text: string): JournalEntry =>
	entry(seq, { kind: "tool_result", callId: id, name, content: [{ type: "text", text }], isError: false });

/** A log: a user, an assistant, a call, a result. */
const sample: readonly JournalEntry[] = [
	user(1, "read a.txt"),
	assistant(2, "let me look"),
	call(3, "c1", "read_file"),
	result(4, "c1", "read_file", "contents"),
];

function foldAll(entries: readonly JournalEntry[]): readonly AgentMessage[] {
	return contextMessages(entries.reduce(foldContext, initialContextState()));
}

describe("the journal", () => {
	test("the envelope carries a monotonic sequence and one version", () => {
		const log = sample.map((e) => e.seq);
		expect(log).toEqual([1, 2, 3, 4]);
		for (const e of sample) expect(e.version).toBe(JOURNAL_VERSION);
	});

	test("the fold gives the model the conversation it had", () => {
		const messages = foldAll(sample);
		expect(messages).toHaveLength(3);
		expect(messages[0]).toEqual({ role: "user", content: "read a.txt" });
		expect(messages[1]?.role).toBe("assistant");
		expect(messages[2]?.role).toBe("toolResult");
	});

	test("a tool call joins the assistant message that asked for it", () => {
		const messages = foldAll(sample);
		const assistantMessage = messages[1];
		if (!assistantMessage || assistantMessage.role !== "assistant") {
			throw new Error("no assistant message");
		}
		expect(assistantMessage.content).toHaveLength(2);
		expect(assistantMessage.content[1]).toEqual({
			type: "toolCall",
			id: "c1",
			name: "read_file",
			argumentsText: "{}",
		});
	});

	test("a block is the model's answer to a refusal, not a hole", () => {
		const messages = foldAll([
			user(1, "delete everything"),
			assistant(2, "as you wish"),
			call(3, "c1", "delete_all"),
			entry(4, { kind: "block", callId: "c1", name: "delete_all", reason: "the user refused" }),
		]);
		expect(messages).toHaveLength(3);
		const answer = messages[2];
		if (!answer || answer.role !== "toolResult") throw new Error("no answer");
		expect(answer.toolCallId).toBe("c1");
		expect(answer.isError).toBe(true);
		expect(answer.content[0]).toEqual({ type: "text", text: "the user refused" });
	});

	test("a compaction collapses the range and keeps the rest", () => {
		const messages = foldAll([
			...sample,
			user(5, "and now b.txt"),
			entry(6, { kind: "compaction", firstKeptSeq: 5, summary: "read a.txt", dropped: 4 }),
		]);
		// The summary is there ...
		const first = messages[0];
		expect(first?.role).toBe("user");
		expect(String(first?.content)).toContain("read a.txt");
		// ... and what began after the boundary is untouched.
		const last = messages[messages.length - 1];
		expect(last).toEqual({ role: "user", content: "and now b.txt" });
	});

	test("a compaction takes the answers to the calls it swallowed", () => {
		const messages = foldAll([
			...sample,
			entry(5, { kind: "compaction", firstKeptSeq: 4, summary: "read a.txt", dropped: 3 }),
		]);
		// The assistant message and its call are gone; an answer to a question the
		// model can no longer see is an orphan, and an orphan is not context.
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(0);
		expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
	});

	test("a compaction collapses every entry below the boundary", () => {
		const messages = foldAll([
			assistant(1, "asking"),
			call(2, "c1", "read_file"),
			entry(3, { kind: "compaction", firstKeptSeq: 3, summary: "s", dropped: 2 }),
			call(4, "c2", "read_file"),
		]);
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
	});

	test("a call that follows a block starts a new assistant message", () => {
		const messages = foldAll([
			user(1, "go"),
			assistant(2, "asking"),
			call(3, "c1", "read_file"),
			entry(4, { kind: "block", callId: "c1", name: "read_file", reason: "refused" }),
			call(5, "c2", "read_file"),
		]);
		const assistants = messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[1]?.content).toHaveLength(1);
	});

	test("a call that follows a user message starts a new assistant message", () => {
		const messages = foldAll([
			assistant(1, "asking"),
			user(2, "interject"),
			call(3, "c1", "read_file"),
		]);
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2);
	});

	test("a change replaces an earlier entry's model-facing view, the history untouched", () => {
		const log: readonly JournalEntry[] = [
			...sample,
			entry(5, { kind: "change", targetSeq: 4, content: [{ type: "text", text: "contents (short)" }] }),
		];
		const messages = foldAll(log);
		const answer = messages[2];
		if (!answer || answer.role !== "toolResult") throw new Error("no answer");
		expect(answer.content[0]).toEqual({ type: "text", text: "contents (short)" });
		// the history is untouched: the entry itself still says what the tool said
		expect(log[3]?.kind).toBe("tool_result");
	});

	test("the replay law: folding the log forward gives the same context as projecting it", () => {
		const forward = foldAll(sample);
		const whole = projectContext(sample);
		expect(forward).toEqual(whole);
	});

	test("the replay law holds with a compaction and a change in the log", () => {
		const log: readonly JournalEntry[] = [
			...sample,
			entry(5, { kind: "change", targetSeq: 4, content: [{ type: "text", text: "short" }] }),
			entry(6, { kind: "compaction", firstKeptSeq: 4, summary: "earlier", dropped: 3 }),
		];
		expect(foldAll(log)).toEqual(projectContext(log));
	});
	test("a call joins the assistant that asked for it, not an earlier one", () => {
		const messages = foldAll([
			user(1, "read a.txt"),
			assistant(2, "let me look"),
			call(3, "c1", "read_file"),
			result(4, "c1", "read_file", "contents"),
			assistant(5, "now b.txt"),
			call(6, "c2", "read_file"),
		]);
		const assistants = messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[0]?.content).toContainEqual({
			type: "toolCall",
			id: "c1",
			name: "read_file",
			argumentsText: "{}",
		});
		expect(assistants[1]?.content).toContainEqual({
			type: "toolCall",
			id: "c2",
			name: "read_file",
			argumentsText: "{}",
		});
		expect(assistants[1]?.content).toHaveLength(2);
	});

	test("both calls of one assistant message join it", () => {
		const messages = foldAll([
			user(1, "read both"),
			assistant(2, "two files"),
			call(3, "c1", "read_file"),
			call(4, "c2", "read_file"),
		]);
		const assistants = messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.content).toHaveLength(3);
	});

	test("the fold does not rewrite the state it was given", () => {
		const state = foldContext(initialContextState(), assistant(1, "old"));
		const snapshot = JSON.stringify(state);
		foldContext(state, entry(2, { kind: "change", targetSeq: 1, content: [{ type: "text", text: "new" }] }));
		expect(JSON.stringify(state)).toEqual(snapshot);
	});

	test("a change replaces the model-facing view of an assistant message", () => {
		const messages = foldAll([
			assistant(1, "the old text"),
			entry(2, { kind: "change", targetSeq: 1, content: [{ type: "text", text: "the new text" }] }),
		]);
		const first = messages[0];
		if (!first || first.role !== "assistant") throw new Error("no assistant");
		expect(first.content).toEqual([{ type: "text", text: "the new text" }]);
	});

	test("a call that follows a result starts a new assistant message", () => {
		const messages = foldAll([
			user(1, "go"),
			assistant(2, "asking"),
			call(3, "c1", "read_file"),
			result(4, "c1", "read_file", "contents"),
			call(5, "c2", "read_file"),
		]);
		const assistants = messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[1]?.content).toHaveLength(1);
	});

	test("a call that follows a compaction joins the assistant that survived it", () => {
		const messages = foldAll([
			assistant(1, "asking"),
			call(2, "c1", "read_file"),
			entry(3, { kind: "compaction", firstKeptSeq: 1, summary: "s", dropped: 0 }),
			call(4, "c2", "read_file"),
		]);
		const assistants = messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.content).toHaveLength(3);
	});

	test("the tool's answer reaches the model", () => {
		const messages = foldAll([
			user(1, "go"),
			assistant(2, "asking"),
			call(3, "c1", "read_file"),
			result(4, "c1", "read_file", "contents"),
		]);
		const answer = messages[2];
		if (!answer || answer.role !== "toolResult") throw new Error("no answer");
		expect(answer.content).toEqual([{ type: "text", text: "contents" }]);
	});
	test("a change of an assistant message keeps its tool calls", () => {
		const messages = foldAll([
			assistant(1, "asking"),
			call(2, "c1", "read_file"),
			entry(3, { kind: "change", targetSeq: 1, content: [{ type: "text", text: "new" }] }),
		]);
		const first = messages[0];
		if (!first || first.role !== "assistant") throw new Error("no assistant");
		expect(first.content).toContainEqual({
			type: "toolCall",
			id: "c1",
			name: "read_file",
			argumentsText: "{}",
		});
	});

	test("a change of an entry that is not there changes nothing", () => {
		const messages = foldAll([
			user(1, "go"),
			entry(2, { kind: "change", targetSeq: 99, content: [{ type: "text", text: "ghost" }] }),
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({ role: "user", content: "go" });
	});

	test("a change does not move the entry it replaces", () => {
		const assistants = foldAll([
			user(1, "go"),
			assistant(2, "asking"),
			entry(3, { kind: "change", targetSeq: 2, content: [{ type: "text", text: "new" }] }),
			call(4, "c1", "read_file"),
		]).filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.content).toHaveLength(2);
	});

	test("a change replaces only the entry it names", () => {
		const messages = foldAll([
			user(1, "first"),
			user(2, "second"),
			entry(3, { kind: "change", targetSeq: 2, content: [{ type: "text", text: "changed" }] }),
		]);
		expect(messages[0]).toEqual({ role: "user", content: "first" });
		expect(messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "changed" }] });
	});

	test("a change does not close the turn that is open", () => {
		const assistants = foldAll([
			assistant(1, "asking"),
			call(2, "c1", "read_file"),
			entry(3, { kind: "change", targetSeq: 1, content: [{ type: "text", text: "new" }] }),
			call(4, "c2", "read_file"),
		]).filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.content).toHaveLength(3);
	});

	test("a change that names a call speaks about the message that holds it", () => {
		const messages = foldAll([
			assistant(1, "asking"),
			call(2, "c1", "read_file"),
			entry(3, { kind: "change", targetSeq: 2, content: [{ type: "text", text: "new" }] }),
		]);
		const first = messages[0];
		if (!first || first.role !== "assistant") throw new Error("no assistant");
		expect(first.content).toContainEqual({ type: "text", text: "new" });
	});

	test("a user message with an image keeps its blocks", () => {
		const messages = foldAll([
			entry(1, {
				kind: "message",
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "A", mimeType: "image/png" },
				],
			}),
		]);
		expect(messages[0]?.content).toEqual([
			{ type: "text", text: "look" },
			{ type: "image", data: "A", mimeType: "image/png" },
		]);
	});

	test("a call joins the assistant without changing it", () => {
		const messages = foldAll([
			entry(1, {
				kind: "message",
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				usage: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
				stopReason: "toolUse",
			}),
			call(2, "c1", "read_file"),
		]);
		const first = messages[0];
		if (!first || first.role !== "assistant") throw new Error("no assistant");
		expect(first.usage).toEqual({ input: 7, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
		expect(first.stopReason).toBe("toolUse");
	});
	test("a compaction closes the open turn it collapsed", () => {
		const state = [
			assistant(1, "asking"),
			call(2, "c1", "read_file"),
			entry(3, { kind: "compaction", firstKeptSeq: 3, summary: "s", dropped: 2 }),
		].reduce(foldContext, initialContextState());
		expect(state.openAssistant).toBeUndefined();
	});

	test("a change that names a call does not move the message that holds it", () => {
		const messages = foldAll([
			assistant(1, "asking"),
			call(2, "c1", "read_file"),
			entry(3, { kind: "change", targetSeq: 2, content: [{ type: "text", text: "new" }] }),
			call(4, "c2", "read_file"),
		]);
		const assistants = messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0]?.content).toHaveLength(3);
	});

	test("two changes for one target: the last one wins", () => {
		const messages = foldAll([
			assistant(1, "first"),
			entry(2, { kind: "change", targetSeq: 1, content: [{ type: "text", text: "second" }] }),
			entry(3, { kind: "change", targetSeq: 1, content: [{ type: "text", text: "third" }] }),
		]);
		expect(messages[0]?.content).toEqual([{ type: "text", text: "third" }]);
	});

	test("a change does not forget the calls of the message it replaces", () => {
		const messages = foldAll([
			assistant(1, "asking"),
			call(2, "c1", "read_file"),
			result(3, "c1", "read_file", "contents"),
			entry(4, { kind: "change", targetSeq: 1, content: [{ type: "text", text: "new" }] }),
			entry(5, { kind: "compaction", firstKeptSeq: 2, summary: "s", dropped: 1 }),
		]);
		expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
	});

	test("a compaction whose boundary falls inside an assistant's calls takes the answers with it", () => {
		const messages = foldAll([
			assistant(1, "asking"),
			call(2, "c1", "read_file"),
			call(3, "c2", "read_file"),
			result(4, "c1", "read_file", "one"),
			result(5, "c2", "read_file", "two"),
			entry(6, { kind: "compaction", firstKeptSeq: 3, summary: "s", dropped: 2 }),
		]);
		expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
	});

	test("a second answer for the same call replaces the first (law M1)", () => {
		const messages = foldAll([
			user(1, "go"),
			assistant(2, "asking"),
			call(3, "c1", "read_file"),
			result(4, "c1", "read_file", "contents"),
			entry(5, { kind: "block", callId: "c1", name: "read_file", reason: "refused" }),
		]);
		const answers = messages.filter((message) => message.role === "toolResult");
		expect(answers).toHaveLength(1);
	});

	test("a call id reused in a later turn is a different call", () => {
		const messages = foldAll([
			user(1, "go"),
			assistant(2, "asking"),
			call(3, "c1", "read_file"),
			result(4, "c1", "read_file", "one"),
			assistant(5, "asking again"),
			call(6, "c1", "read_file"),
			result(7, "c1", "read_file", "two"),
		]);
		const answers = messages.filter((message) => message.role === "toolResult");
		expect(answers).toHaveLength(2);
	});
});
