import { parseInstant, parsePlainDate, parsePlainDateTime } from "./temporalValues.ts";

/**
 * The date/time OID→parser mapping that makes this package's published types
 * TRUE at runtime, held in ONE place because two different drivers have to
 * agree on it.
 *
 * `createDb()` runs on `pg` and configures it through {@link
 * ./pgTypeParsers.ts makePgTypes}. The canonical readers
 * (`./canonical/mod.ts`) compile a query and hand the SQL to a postgres.js
 * connection the caller owns, so postgres.js does the parsing there and needs
 * its own configuration built from the same table. Both read this module.
 *
 * The failure mode this heads off is asymmetric and silent: with only the `pg`
 * half configured, the types are true under `createDb()` and false under a
 * compiled query — same interfaces, `Date` objects instead of Temporal values,
 * and nothing anywhere throws.
 *
 * This module is deliberately driver-free. `pgTypeParsers.ts` imports `pg`, and
 * a canonical reader must not: `services/` and `mcp-local` connect with
 * postgres.js and have no `pg` in their import maps.
 *
 * Only the date/time OIDs are listed. `numeric` and `int8` already come back as
 * strings from both drivers, which is exactly what the generated types say, so
 * a parser for them would be motion without effect. Array OIDs are absent too:
 * the published schema contains no timestamp arrays (the only array column is
 * `bigint[]`, which both drivers yield as strings). If a timestamp array column
 * is ever published, OIDs 1115, 1182 and 1185 must be added here.
 */

/** `date` → `Temporal.PlainDate`. */
export const OID_DATE = 1082;

/** `timestamp without time zone` → `Temporal.PlainDateTime`, with no offset invented. */
export const OID_TIMESTAMP = 1114;

/** `timestamp with time zone` → `Temporal.Instant`. */
export const OID_TIMESTAMPTZ = 1184;

/** A parser reads Postgres's TEXT rendering of one value. */
export type TemporalOidParser = (value: string) => Temporal.Instant | Temporal.PlainDateTime | Temporal.PlainDate;

/**
 * The parsers, by Postgres type OID.
 *
 * Exported through `mod.ts` so a customer who builds their own dialect can make
 * their runtime agree with the types they are importing.
 */
export const temporalOidParsers: Readonly<Record<number, TemporalOidParser>> = {
	[OID_DATE]: parsePlainDate,
	[OID_TIMESTAMP]: parsePlainDateTime,
	[OID_TIMESTAMPTZ]: parseInstant,
};
