import { Effect } from "effect";
import { operationError } from "./operationError.ts";

/** Run Promise work, preserving failures through operationError. */
export function tryPromiseOrOperationError<A>(fn: () => Promise<A>): Effect.Effect<A, Error> {
	return Effect.tryPromise({ try: fn, catch: operationError });
}
