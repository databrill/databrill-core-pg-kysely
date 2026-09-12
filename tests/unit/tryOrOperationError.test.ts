import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1.0.19";
import { Either } from "effect";
import { tryOrOperationError } from "../../src/tryOrOperationError.ts";

Deno.test("tryOrOperationError runs immediately once and preserves the result", () => {
	const value = { count: 42 };
	let calls = 0;
	const result = tryOrOperationError(() => {
		calls++;
		return value;
	});
	assertEquals(calls, 1);
	assert(Either.isRight(result));
	assertStrictEquals(result.right, value);
});

Deno.test("tryOrOperationError preserves the original Error and its cause", () => {
	const cause = { reason: "plugin refused" };
	const failure = new Error("compilation failed", { cause });
	const result = tryOrOperationError(() => {
		throw failure;
	});
	assert(Either.isLeft(result));
	assertStrictEquals(result.left, failure);
	assertStrictEquals(result.left.cause, cause);
});

Deno.test("tryOrOperationError retains a non-Error failure as the cause", () => {
	const cause = { reason: "foreign failure" };
	const result = tryOrOperationError(() => {
		throw cause;
	});
	assert(Either.isLeft(result));
	assert(result.left instanceof Error);
	assertStrictEquals(result.left.cause, cause);
	assertEquals(result.left.message, "Database operation failed");
});
