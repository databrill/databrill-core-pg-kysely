import { type RawBuilder, sql } from "kysely";
import type { DB } from "../types.ts";

/**
 * Relation and column names that a rename in the generated schema turns into a
 * compile error.
 *
 * Parts of a canonical reader — window functions, ordered-set aggregates,
 * `FILTER` clauses — are clearer written as SQL than assembled through the query
 * builder. The cost of dropping to raw SQL is normally that every identifier
 * becomes an unchecked string, and the failure that produces is a runtime
 * `column ... does not exist` on a customer database rather than a red squiggle
 * here.
 *
 * These two helpers buy the checking back for a few characters: the names are
 * constrained to `keyof DB` and `keyof DB[Relation]`, so they are verified
 * against the same generated interface `db.selectFrom(...)` is verified against,
 * while the emitted SQL is still `sql.table` / `sql.ref` and therefore still
 * properly quoted.
 */

/** A quoted relation name, checked against the generated `DB` interface. */
export function rel<R extends keyof DB & string>(relation: R): RawBuilder<unknown> {
	return sql.table(relation);
}

/**
 * A quoted column name, checked against the generated `DB` interface.
 *
 * `relation` is only there to type `column`; it is not emitted. Pass a qualified
 * name when the query needs one — `col("amazon_store", "merchantId")` emits
 * `"merchantId"`, and `qualified` adds the alias.
 */
export function col<R extends keyof DB & string, C extends keyof DB[R] & string>(
	relation: R,
	column: C,
): RawBuilder<unknown> {
	void relation;
	return sql.ref(column);
}

/** A column qualified by a table alias: `alias."column"`, with the name still checked. */
export function qualified<R extends keyof DB & string, C extends keyof DB[R] & string>(
	relation: R,
	alias: string,
	column: C,
): RawBuilder<unknown> {
	void relation;
	return sql.ref(`${alias}.${column}`);
}
