import { Result } from "effect";
import { assert, assertInstanceOf, assertStringIncludes } from "jsr:@std/assert@1.0.19";

/** Assert a synchronous typed failure and preserve the original error. */
export function assertEitherFailure<A, E, T extends Error>(
	make: () => Result.Result<A, E>,
	errorClass: new (...args: never[]) => T,
	messageIncludes = "",
): T {
	const result = make();
	assert(Result.isFailure(result), "expected failure");
	assertInstanceOf(result.failure, errorClass);
	assertStringIncludes(result.failure.message, messageIncludes);
	return result.failure;
}
