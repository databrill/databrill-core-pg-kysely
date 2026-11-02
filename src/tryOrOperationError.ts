import { Result } from "effect";
import { operationError } from "./operationError.ts";

/** Run synchronous work, preserving failures through operationError. */
export function tryOrOperationError<A>(fn: () => A): Result.Result<A, Error> {
	return Result.try({ try: fn, catch: operationError });
}
