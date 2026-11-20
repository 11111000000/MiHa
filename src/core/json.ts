/**
 * JSON parsing that cannot throw.
 *
 * The core treats errors as values (ADR 0004 Q5). `JSON.parse` is the one place in
 * the core that would otherwise raise, so it is wrapped once, here, and every caller
 * gets a `Result` instead of an exception.
 */

export type JsonParseResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: string };

export function parseJson(text: string): JsonParseResult {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
