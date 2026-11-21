/**
 * The SSE reader.
 *
 * Server-sent events, as the OpenAI-compatible wire format uses them: a stream of
 * `data:` records separated by a blank line, terminated by `data: [DONE]`.
 *
 * Two things this gets right that a naive reader gets wrong:
 *
 * - **The last record may arrive without a trailing newline.** A record is only
 *   complete when a blank line follows it, but the stream may end right after the
 *   last `data:` line. The reader yields what it has when the stream ends.
 * - **A record's data may span several `data:` lines.** They join with a newline.
 */

const decoder = new TextDecoder();

export async function* readSseData(
	stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
	let buffer = "";
	let data: string[] = [];

	/**
	 * Takes one line and yields the record it completes.
	 *
	 * It is a generator because a blank line completes a record and yields it; every
	 * other line only collects.
	 */
	function* take(line: string): Generator<string> {
		if (line === "") {
			if (data.length > 0) {
				yield data.join("\n");
				data = [];
			}
			return;
		}
		if (line.startsWith(":")) return;

		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") data.push(value);
	}

	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });

		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			yield* take(line);
		}
	}

	// The stream may end right after the last data line, with no newline and no
	// blank line to close the record.
	const rest = buffer.replace(/\r$/, "");
	if (rest !== "") yield* take(rest);
	if (data.length > 0) yield data.join("\n");
}
