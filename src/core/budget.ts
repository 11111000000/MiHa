/**
 * The result budget (ADR 0006 D34, default ADR 0009 D50).
 *
 * The core truncates every tool result whose text exceeds the budget — failures
 * included — keeping the head and tail halves of the bytes and inserting a block that
 * names the numbers: `[result truncated: N of M bytes omitted]`. A document's schema
 * lives at its top and its summary at its bottom, so both survive. `Infinity` disables
 * the budget; non-text blocks pass through untouched, bounded by the host that made
 * them rather than by this core.
 */

import type { ImageContent, TextContent, ToolResultMessage } from "./messages.ts";

/** The default budget: 8 192 B — a quarter of the bundle ceiling (ADR 0009 D50). */
export const DEFAULT_RESULT_BUDGET = 8192;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Resolves the host's budget into the one the core enforces.
 *
 * `Infinity` disables the budget. A budget of zero is honoured: nothing is kept but
 * the announcement. A budget that is not a number, or a negative one, is nonsense, and
 * nonsense gets the default rather than an unbounded result.
 */
export function resolveBudget(budget: number | undefined): number {
	if (budget === undefined) return DEFAULT_RESULT_BUDGET;
	if (budget === Number.POSITIVE_INFINITY) return budget;
	if (Number.isNaN(budget) || budget < 0) return DEFAULT_RESULT_BUDGET;
	return budget;
}

/** Steps back to the start of the codepoint that `index` sits inside. */
function startOfCodepoint(bytes: Uint8Array, index: number): number {
	let at = index;
	while (at > 0 && ((bytes[at] ?? 0) & 0xc0) === 0x80) at -= 1;
	return at;
}

/** Steps forward past any continuation bytes to the start of the next codepoint. */
function nextCodepoint(bytes: Uint8Array, index: number): number {
	let at = index;
	while (at < bytes.length && ((bytes[at] ?? 0) & 0xc0) === 0x80) at += 1;
	return at;
}

/**
 * The size of a text in bytes.
 */
export function textBytes(text: string): number {
	return encoder.encode(text).length;
}

/**
 * Cuts text to a number of bytes, never splitting a codepoint.
 *
 * The same rule the result budget follows: a cut that lands inside a codepoint would
 * put a broken character in the model's context, and the model reads it.
 */
export function cutText(text: string, bytes: number): string {
	if (bytes <= 0) return "";
	const whole = encoder.encode(text);
	if (whole.length <= bytes) return text;
	return decoder.decode(whole.subarray(0, startOfCodepoint(whole, bytes)));
}

/**
 * Applies the budget to one result.
 *
 * The text blocks are joined and measured as UTF-8 bytes; if they fit, the result is
 * returned as-is. If they do not, the result keeps the head and tail halves of the
 * budget and an announcement naming the omitted and total byte counts. The `details`
 * field survives untouched — the interface reads it even when the model cannot.
 */
export function truncateToolResult(
	result: ToolResultMessage,
	budget: number,
): ToolResultMessage {
	return { ...result, content: truncateContent(result.content, budget) };
}

/**
 * The same budget for a content array — the live progress channel uses it, because a
 * tool that reports a megabyte of partial output must not put the harness's memory
 * law at the mercy of the tool (ADR 0009 D50).
 */
export function truncateContent(
	content: readonly (TextContent | ImageContent)[],
	budget: number,
): readonly (TextContent | ImageContent)[] {
	if (budget === Number.POSITIVE_INFINITY) return content;
	const limit = Number.isNaN(budget) || budget < 0 ? DEFAULT_RESULT_BUDGET : budget;

	const texts = content.filter(
		(block): block is TextContent => block.type === "text",
	);
	const others = content.filter((block) => block.type !== "text");
	const whole = encoder.encode(texts.map((block) => block.text).join("\n"));
	const totalBytes = whole.length;
	if (totalBytes <= limit) return content;

	const headEnd = startOfCodepoint(whole, Math.ceil(limit / 2));
	const tailStart = nextCodepoint(whole, totalBytes - Math.floor(limit / 2));
	const head = decoder.decode(whole.subarray(0, headEnd));
	const tail = decoder.decode(whole.subarray(tailStart));
	const kept = headEnd + (totalBytes - tailStart);
	const announcement = `[result truncated: ${totalBytes - kept} of ${totalBytes} bytes omitted]`;

	const cut: (TextContent | ImageContent)[] = [
		...(head ? [{ type: "text", text: head } as TextContent] : []),
		{ type: "text", text: announcement } as TextContent,
		...(tail ? [{ type: "text", text: tail } as TextContent] : []),
		...others,
	];
	return cut;
}
