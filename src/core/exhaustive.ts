/**
 * Exhaustive handling.
 *
 * `assertNever` is the mechanism that makes a missing union arm a **compile error**
 * rather than a runtime surprise. It accepts only a value that the compiler can prove
 * is unreachable; when an arm is forgotten, the value at that point is no longer
 * `never` and the call does not type-check.
 */

export function assertNever(value: never, context?: string): never {
	throw new Error(
		context
			? `${context}: unexpected value ${JSON.stringify(value)}`
			: `unexpected value ${JSON.stringify(value)}`,
	);
}
