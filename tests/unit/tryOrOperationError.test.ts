import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1.0.19";
import { Result } from "effect";
import { tryOrOperationError } from "../../src/tryOrOperationError.ts";

Deno.test("tryOrOperationError runs immediately once and preserves the result", () => {
	const value = { count: 42 };
	let calls = 0;
	const result = tryOrOperationError(() => {
		calls++;
		return value;
	});
	assertEquals(calls, 1);
	assert(Result.isSuccess(result));
	assertStrictEquals(result.success, value);
});

Deno.test("tryOrOperationError preserves the original Error and its cause", () => {
	const cause = { reason: "plugin refused" };
	const failure = new Error("compilation failed", { cause });
	const result = tryOrOperationError(() => {
		throw failure;
	});
	assert(Result.isFailure(result));
	assertStrictEquals(result.failure, failure);
	assertStrictEquals(result.failure.cause, cause);
});

Deno.test("tryOrOperationError retains a non-Error failure as the cause", () => {
	const cause = { reason: "foreign failure" };
	const result = tryOrOperationError(() => {
		throw cause;
	});
	assert(Result.isFailure(result));
	assert(result.failure instanceof Error);
	assertStrictEquals(result.failure.cause, cause);
	assertEquals(result.failure.message, "Database operation failed");
});
