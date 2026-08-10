import pg from "pg";
import { parseInstant, parsePlainDate, parsePlainDateTime } from "./temporalValues.ts";

/**
 * Driver-level type parsers that make this package's published types TRUE at
 * runtime.
 *
 * Without them the types lie. `pg` parses `date`, `timestamp` and `timestamptz`
 * into JavaScript `Date` objects by default, while the generated interfaces
 * declare Temporal values — so `db.selectFrom(...)` would type-check and then
 * hand back an object of a different type entirely. That is the whole reason
 * `createDb()` exists rather than a README paragraph telling customers to build
 * their own pool.
 *
 * Only the date/time OIDs are overridden. `numeric` and `int8` already come
 * back as strings from `pg`, which is exactly what the generated types say, so
 * registering a parser for them would be motion without effect. Array OIDs are
 * not overridden either: the published schema contains no timestamp arrays (the
 * only array column is `bigint[]`, which `pg` yields as strings). If a
 * timestamp array column is ever published, OIDs 1115, 1182 and 1185 must be
 * added here — and the round-trip integration test is what will catch it.
 */

/** `date` → `Temporal.PlainDate`. */
const OID_DATE = 1082;

/** `timestamp without time zone` → `Temporal.PlainDateTime`, with no offset invented. */
const OID_TIMESTAMP = 1114;

/** `timestamp with time zone` → `Temporal.Instant`. */
const OID_TIMESTAMPTZ = 1184;

/**
 * The parsers, by Postgres type OID.
 *
 * Exported so a customer who builds their own dialect can make their runtime
 * agree with the types they are importing. Using raw `pg` without them yields
 * `Date` objects, at which point the published types are wrong.
 */
export const pgTypeParsers: Readonly<
	Record<number, (value: string) => Temporal.Instant | Temporal.PlainDateTime | Temporal.PlainDate>
> = {
	[OID_DATE]: parsePlainDate,
	[OID_TIMESTAMP]: parsePlainDateTime,
	[OID_TIMESTAMPTZ]: parseInstant,
};

/**
 * Build the object to hand to a `pg` `Pool` as its `types` option.
 *
 * Per-pool, never global: `pg.types.setTypeParser` would rewrite parsing for
 * every pool in the customer's process, including pools this package knows
 * nothing about. Overriding `getTypeParser` on one pool's config affects only
 * that pool, and delegates every other OID to `pg`'s own defaults.
 */
export function makePgTypes(): { readonly getTypeParser: typeof pg.types.getTypeParser } {
	return { getTypeParser };
}

/**
 * Our parser for the date/time OIDs, `pg`'s own for everything else.
 *
 * Binary format is delegated too: the parsers here read Postgres's TEXT
 * rendering, and handing one a binary buffer would produce nonsense. `pg` only
 * requests binary when a caller asks for it, which is reachable through the
 * exposed pool, so the case is worth handling rather than assuming away.
 */
function getTypeParser(oid: number, format?: "text" | "binary"): unknown {
	const parser = format === "binary" ? undefined : pgTypeParsers[oid];
	if (parser !== undefined) {
		return parser;
	}
	return pg.types.getTypeParser(oid, format);
}
