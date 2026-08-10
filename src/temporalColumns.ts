import type { ColumnType } from "kysely";

/**
 * The column types the generated schema uses for PostgreSQL date and time
 * types.
 *
 * They live here, hand-written, rather than being inlined into every column of
 * the generated file: one definition to read, one place to change, and a
 * generated file that says `InstantColumn` instead of repeating a three-argument
 * generic several thousand times.
 *
 * Each accepts a Temporal value OR an ISO-8601 string on write, since both are
 * unambiguous, and `temporalParameterPlugin` renders the Temporal case before it
 * reaches the driver. Reads are always Temporal.
 *
 * `Temporal` is a global — native in Deno and Node 26+, a `temporal-polyfill`
 * import away on Node 24 and Bun. The TYPE declarations are a separate matter:
 * Deno has them by default and TypeScript 7+ exposes them as the
 * `esnext.temporal` lib, but TypeScript 5.x and 6.x have no such lib, and there
 * the `temporal-polyfill/global` import is what supplies them.
 */

/** `timestamptz` — an exact instant, offset included. */
export type InstantColumn = ColumnType<Temporal.Instant, Temporal.Instant | string, Temporal.Instant | string>;

/**
 * `timestamp without time zone` — a wall-clock reading with NO offset.
 *
 * Deliberately not an `Instant`: the database is not claiming to know which
 * moment this was, and neither should the type.
 */
export type PlainDateTimeColumn = ColumnType<
	Temporal.PlainDateTime,
	Temporal.PlainDateTime | string,
	Temporal.PlainDateTime | string
>;

/** `date` — a calendar day, with no time and no zone. */
export type PlainDateColumn = ColumnType<Temporal.PlainDate, Temporal.PlainDate | string, Temporal.PlainDate | string>;
