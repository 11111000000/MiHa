import { describe, expect, test } from "bun:test";
import { EventStream } from "../src/core/event-stream.ts";

type TestEvent = { type: "text"; value: string } | { type: "done"; value: string };

function makeStream() {
	return new EventStream<TestEvent, string>({
		isTerminal: (event) => event.type === "done",
		extract: (event) => (event as { value: string }).value,
	});
}

describe("stream laws", () => {
	test("S1 — events are delivered in push order, each exactly once", async () => {
		const stream = makeStream();
		stream.push({ type: "text", value: "a" });
		stream.push({ type: "text", value: "b" });
		stream.push({ type: "done", value: "z" });

		const seen: string[] = [];
		for await (const event of stream) seen.push(event.value);

		expect(seen).toEqual(["a", "b", "z"]);
	});

	test("S2 — result resolves exactly once, with the terminal event's value", async () => {
		const stream = makeStream();
		stream.push({ type: "done", value: "final" });
		expect(await stream.result()).toBe("final");
		expect(await stream.result()).toBe("final");
	});

	test("S3 — events pushed after the terminal event are ignored", async () => {
		const stream = makeStream();
		stream.push({ type: "done", value: "final" });
		stream.push({ type: "text", value: "late" });

		const seen: string[] = [];
		for await (const event of stream) seen.push(event.value);

		expect(seen).toEqual(["final"]);
		expect(stream.closed).toBe(true);
	});

	test("S4 — iteration ends after the terminal event has been delivered", async () => {
		const stream = makeStream();
		stream.push({ type: "done", value: "final" });

		let count = 0;
		for await (const _event of stream) count++;

		expect(count).toBe(1);
	});

	test("S5 — no event is lost between a push and the start of iteration", async () => {
		const stream = makeStream();
		stream.push({ type: "text", value: "early" });
		stream.push({ type: "text", value: "earlier" });
		stream.push({ type: "done", value: "z" });

		const seen: string[] = [];
		for await (const event of stream) seen.push(event.value);

		expect(seen).toEqual(["early", "earlier", "z"]);
	});
});

describe("failure modes", () => {
	test("a failure rejects result and iteration", async () => {
		const stream = makeStream();
		stream.fail(new Error("adapter exploded"));

		await expect(stream.result()).rejects.toThrow("adapter exploded");
		await expect((async () => {
			for await (const _event of stream) {
				// consume
			}
		})()).rejects.toThrow("adapter exploded");
	});

	test("closing without a terminal event rejects rather than hanging", async () => {
		const stream = makeStream();
		stream.close();
		await expect(stream.result()).rejects.toThrow("closed without a terminal event");
	});

	test("a failure after close is ignored", async () => {
		const stream = makeStream();
		stream.close();
		stream.fail(new Error("late failure"));
		await expect(stream.result()).rejects.toThrow("closed without a terminal event");
	});
});
