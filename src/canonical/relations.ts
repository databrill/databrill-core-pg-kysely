import { type Kysely, sql } from "kysely";
import type { DB } from "../types.ts";
import { type CanonicalQueryRunner, executeCompiled } from "./execute.ts";

/**
 * Which of a reader's declared source relations this database actually has.
 *
 * A declaration names the relations a reader needs so that a missing one is an
 * ANSWER rather than an exception: tenant databases run at different schema
 * versions, view provisioning is a separate step from table provisioning, and
 * Amazon does not publish every report for every seller. "This level is
 * unavailable on this database, because …" is information a consumer can act on;
 * a `relation does not exist` from the driver is not.
 *
 * `to_regclass` resolves against the connection's `search_path`, which is
 * already pinned to the caller's workspace schema, so this asks exactly the
 * question the reader's own queries will ask.
 */
export async function probeRelations(
	db: Kysely<DB>,
	runner: CanonicalQueryRunner,
	relations: readonly string[],
): Promise<ReadonlySet<string>> {
	if (relations.length === 0) {
		return new Set();
	}
	const query = sql<{ relation: string; present: boolean }>`
		SELECT r AS "relation", to_regclass(quote_ident(r)) IS NOT NULL AS "present"
		FROM unnest(${sql.val(relations)}::text[]) AS r
	`;
	const rows = await executeCompiled(runner, query.compile(db));
	return new Set(rows.filter((row) => row.present).map((row) => row.relation));
}
