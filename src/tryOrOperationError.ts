import { Either } from "effect";
import { operationError } from "./operationError.ts";

/** Run synchronous work, preserving failures through operationError. */
export function tryOrOperationError<A>(fn: () => A): Either.Either<A, Error> {
	return Either.try({ try: fn, catch: operationError });
}
