/** Preserve foreign errors; retain non-Error rejection values as the cause. */
export function operationError(cause: unknown): Error {
	return cause instanceof Error ? cause : Object.assign(new Error("Database operation failed", { cause }), {
		operation: "database",
	});
}
