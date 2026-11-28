/**
 * The provider: MiniMax, over the OpenAI-compatible path.
 *
 * The base URL is the one that answered for our key (ADR 0014 D71): the
 * documented international endpoint of the OpenAI-compatible path. The key itself
 * is asked for in the page and handed over with the run — it is never written to a
 * file, never bundled, and never sent anywhere but the provider.
 *
 * The model's own knobs live in the options bag, because that is where the
 * provider's knobs belong (ADR 0014 D74, D75): `reasoning_split` puts the
 * thinking in its own field, and `thinking` says what the path accepts.
 */

import { openaiCompat } from "../../src/llm/index.ts";
import type { ProviderFn } from "../../src/llm/index.ts";

/** The base URL of the OpenAI-compatible path. */
export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";

/**
 * The model the example asks for.
 *
 * The cheapest and fastest of the models this account may use: MiniMax-M2 and
 * MiniMax-M2.1 are gone from the API, M3.1-Flash refuses every request without
 * thinking, and the M2.5 tier answers a tool call in about a second. The flagship
 * M3 is four times the price of the Flash tier and buys nothing a harness needs.
 */
export const MODEL = "MiniMax-M2.5-highspeed";

/** The provider's knobs, handed to the wire verbatim. */
export const MINIMAX_OPTIONS: Readonly<Record<string, unknown>> = {
	reasoning_split: true,
	thinking: { type: "adaptive" },
};

/** The provider, for a key that is in memory and nowhere else. */
export function minimaxProvider(apiKey: string): ProviderFn {
	return openaiCompat({
		baseUrl: MINIMAX_BASE_URL,
		apiKey,
	});
}
