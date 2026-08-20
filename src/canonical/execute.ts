import {
	type CompiledQuery,
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import type { DB } from "../types.ts";
import { OID_DATE, OID_TIMESTAMP, OID_TIMESTAMPTZ, temporalOidParsers } from "../temporalOidParsers.ts";
import { temporalToPostgres } from "../temporalValues.ts";

/**
 * Kysely as a query COMPILER, and the postgres.js configuration that makes the
 * compiled query's row types true.
 *
 * The canonical readers do not own a connection. They build a query against the
 * generated `DB` interface, call `.compile()`, and hand the resulting
 * `{ sql, parameters }` to a postgres.js connection the caller injects — the
 * connection that already carries the caller's workspace `search_path`, role and
 * pool. Kysely never opens a socket here, which is why {@link
 * createCanonicalQueryBuilder} installs {@link DummyDriver}: a `Kysely<DB>` that
 * can never connect is a supported object, and executing through it would be the
 * bug, not the missing feature.
 *
 * What the caller gains over hand-written SQL is that `InferResult<typeof query>`
 * types the rows from the same interface the query was built against, so a
 * renamed column is a type error rather than an `undefined` at runtime.
 */

/**
 * A Kysely instance typed by the tenant schema that compiles but cannot execute.
 *
 * `PostgresAdapter` and `PostgresQueryCompiler` produce PostgreSQL dialect SQL
 * with `$1`-style placeholders, which is exactly what postgres.js's `unsafe()`
 * expects. `PostgresIntrospector` is required by the dialect interface and is
 * unreachable without a driver.
 *
 * Build one per call site or hold one for the process — it carries no
 * connection, so there is nothing to leak and nothing to destroy.
 */
export function createCanonicalQueryBuilder(): Kysely<DB> {
	return new Kysely<DB>({
		dialect: {
			createAdapter: () => new PostgresAdapter(),
			createDriver: () => new DummyDriver(),
			createIntrospector: (db: Kysely<DB>) => new PostgresIntrospector(db),
			createQueryCompiler: () => new PostgresQueryCompiler(),
		},
	});
}

/**
 * The one method a canonical reader needs from an injected connection.
 *
 * Structural rather than an import of postgres.js's `Sql`: this package declares
 * `kysely` and `pg` and nothing else, and a canonical reader must not add a
 * second driver to that list. A real postgres.js `Sql` satisfies this shape, so
 * a caller passes `sql` directly with no adapter.
 *
 * `parameters` is always non-empty in practice for a reader with a date window,
 * which keeps the statement on the extended protocol — the same property
 * `mcp-local`'s loaders rely on so that no fragment can ever stack a second
 * statement.
 */
export interface CanonicalQueryRunner {
	unsafe<Rows extends unknown[]>(query: string, parameters?: readonly unknown[]): PromiseLike<Rows>;
}

/**
 * Execute a compiled Kysely query on an injected postgres.js connection.
 *
 * The row type comes from the `CompiledQuery<O>` that `.compile()` produced, so
 * it is the same type `InferResult<typeof query>` reports and no assertion is
 * needed to get it.
 *
 * The VALUES are only as true as the connection's type configuration — see
 * {@link makePostgresJsTypes}. A connection built without it returns `Date`
 * objects where these types promise Temporal values.
 */
export async function executeCompiled<O>(
	runner: CanonicalQueryRunner,
	compiled: CompiledQuery<O>,
): Promise<O[]> {
	return await runner.unsafe<O[]>(compiled.sql, compiled.parameters);
}

/**
 * One entry of a postgres.js `types` option: the shape its `Options.types`
 * requires.
 *
 * `from` is a mutable `number[]` rather than `readonly number[]` because
 * postgres.js's own `PostgresType` declares it mutable, and TypeScript relates
 * array element mutability strictly through an index signature — a
 * `readonly number[]` here makes the whole record unassignable to the driver's
 * options. Property `readonly` modifiers are fine and are kept.
 */
export interface PostgresJsTypeHandler {
	readonly to: number;
	readonly from: number[];
	readonly serialize: (value: unknown) => unknown;
	readonly parse: (raw: string) => Temporal.Instant | Temporal.PlainDateTime | Temporal.PlainDate;
}

/**
 * Build the `types` option for the postgres.js connection a canonical reader
 * will run on.
 *
 * Required, not optional. postgres.js parses `date`, `timestamp` and
 * `timestamptz` into JavaScript `Date` objects by default (one built-in handler
 * covering OIDs 1082, 1114 and 1184), while the generated interfaces declare
 * `Temporal.PlainDate`, `Temporal.PlainDateTime` and `Temporal.Instant`. Without
 * this the compiled query type-checks and hands back objects of a different
 * type — the same lie `makePgTypes()` heads off on the `pg` side, from the same
 * OID table in `../temporalOidParsers.ts`.
 *
 * Three separate handlers rather than one, because postgres.js keys the
 * PARSER map by source OID but the SERIALIZER map by `to`: a single handler
 * could only name one `to`, so a bound value of the other two types would be
 * rendered by the wrong serializer.
 *
 * ```ts
 * const sql = postgres(uri, { types: makePostgresJsTypes() });
 * ```
 */
export function makePostgresJsTypes(): Readonly<Record<string, PostgresJsTypeHandler>> {
	return {
		plainDate: handlerFor(OID_DATE),
		plainDateTime: handlerFor(OID_TIMESTAMP),
		instant: handlerFor(OID_TIMESTAMPTZ),
	};
}

function handlerFor(oid: number): PostgresJsTypeHandler {
	const parse = temporalOidParsers[oid];
	if (parse === undefined) {
		throw new Error(`No Temporal parser registered for Postgres OID ${oid}`);
	}
	return { to: oid, from: [oid], serialize: temporalToPostgres, parse };
}
