import { Either } from "effect";
import { assert, assertInstanceOf, assertStringIncludes } from "jsr:@std/assert@1.0.19";

/** Assert a synchronous typed failure and preserve the original error. */
export function assertEitherFailure<A, E, T extends Error>(
	make: () => Either.Either<A, E>,
	errorClass: new (...args: never[]) => T,
	messageIncludes = "",
): T {
	const result = make();
	assert(Either.isLeft(result), "expected failure");
	assertInstanceOf(result.left, errorClass);
	assertStringIncludes(result.left.message, messageIncludes);
	return result.left;
}
