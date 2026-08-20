import { types } from "pg";
import { temporalOidParsers } from "./temporalOidParsers.ts";

/**
 * Driver-level type parsers that make this package's published types TRUE at
 * runtime, for the `pg` driver `createDb()` uses.
 *
 * Without them the types lie. `pg` parses `date`, `timestamp` and `timestamptz`
 * into JavaScript `Date` objects by default, while the generated interfaces
 * declare Temporal values — so `db.selectFrom(...)` would type-check and then
 * hand back an object of a different type entirely. That is the whole reason
 * `createDb()` exists rather than a README paragraph telling customers to build
 * their own pool.
 *
 * The OID→parser table itself is in `./temporalOidParsers.ts`, which imports no
 * driver, because the canonical readers configure postgres.js from the same
 * table. Which OIDs are covered, and why the list stops where it does, is
 * documented there.
 */

/**
 * The parsers, by Postgres type OID.
 *
 * Re-exported under this package's published name. Using raw `pg` without them
 * yields `Date` objects, at which point the published types are wrong.
 */
export const pgTypeParsers: Readonly<
	Record<number, (value: string) => Temporal.Instant | Temporal.PlainDateTime | Temporal.PlainDate>
> = temporalOidParsers;

/**
 * Build the object to hand to a `pg` `Pool` as its `types` option.
 *
 * Per-pool, never global: `pg.types.setTypeParser` would rewrite parsing for
 * every pool in the customer's process, including pools this package knows
 * nothing about. Overriding `getTypeParser` on one pool's config affects only
 * that pool, and delegates every other OID to `pg`'s own defaults.
 */
export function makePgTypes(): { readonly getTypeParser: typeof types.getTypeParser } {
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
	return types.getTypeParser(oid, format);
}
