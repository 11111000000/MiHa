/**
 * The layers of the library, and what each may cost.
 *
 * One list, used by both the budget check and the layer-agreement check, so the two
 * cannot disagree about what the layers are.
 *
 * The order is the dependency direction: a layer may import the ones above it in
 * this list, and never the ones below.
 */

export const LAYERS = {
	/** The barrel. `src/index.ts` and the per-layer barrels. */
	root: 50,
	/** The tool-parameter dialect: types, validation, conversion. */
	schema: 500,
	/** The algebras, the tool contract and dispatch, the transcript, the state machine, the driver. */
	core: 1500,
	/** Provider adapters: the SSE reader, the call tracker, the wire formats. */
	llm: 600,
	/** The peer protocol and its transports. */
	exchange: 700,
	/** The worker host and the capability bridge. */
	worker: 500,
	/** The run record, the cassette and the replay mode. */
	trace: 250,
	/** The component registry, the interface spec and the patches. */
	ui: 800,
};

/** The layers the architectural decision names. `root` is the barrel, not a layer. */
export const NAMED_LAYERS = Object.keys(LAYERS).filter((name) => name !== "root");
