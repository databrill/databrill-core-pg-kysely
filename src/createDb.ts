import { Kysely, PostgresDialect } from "kysely";
import type { ReadonlyKysely } from "kysely/readonly";
import { Pool, type PoolConfig } from "pg";
import type { DB } from "./db.ts";
import { makePgTypes } from "./pgTypeParsers.ts";
import { temporalParameterPlugin } from "./temporalParameterPlugin.ts";
import { requireTemporal } from "./temporalValues.ts";
import type { WritableDB } from "./WritableDB.ts";

/**
 * Options for {@link createDb}. Everything `pg`'s `Pool` accepts, minus `types`,
 * which this package owns — see {@link makePgTypes} for why overriding it would
 * make the published types wrong.
 */
export interface CreateDbOptions extends Omit<PoolConfig, "types"> {
	/**
	 * The Postgres schema holding the tenant tables.
	 *
	 * Hosted workspaces live in a `w<wsid>` schema; a bring-your-own Supabase
	 * project normally uses `public`. Omit it to use whatever the connection's
	 * `search_path` resolves to.
	 *
	 * Applied with Kysely's `withSchema()`, which qualifies identifiers in the
	 * SQL it emits. That is deliberately not a driver-level `search_path`: a
	 * startup parameter is not forwarded by every connection pooler, and a
	 * per-session `SET` does not survive transaction-mode pooling, where each
	 * transaction may land on a different backend. Qualifying the SQL works
	 * regardless of how the connection is pooled.
	 */
	readonly schema?: string;
}

/**
 * A connected tenant database: reads over everything, writes where intended.
 */
export interface TenantDb {
	/**
	 * Every published table and view, read-only.
	 *
	 * Mutations and DDL are compile-time type errors. This is a convenience for
	 * callers, NOT a security boundary — the enforceable boundary is the grants
	 * held by the role in the connection string. Treat a compile error here as a
	 * hint that you meant to use {@link TenantDb.write}, never as proof that a
	 * write could not have happened.
	 */
	readonly db: ReadonlyKysely<DB>;

	/**
	 * The tables customers are intended to write, as a normal Kysely instance.
	 *
	 * The table list is derived from the same per-table flag that drives the
	 * database grants, so the type boundary and the security boundary are one
	 * list defined in one place.
	 */
	readonly write: Kysely<WritableDB>;

	/**
	 * The underlying pool, shared by both surfaces.
	 *
	 * Exposed as an escape hatch for connection metrics and for SQL this package
	 * cannot express. Do not call `end()` on it directly; use
	 * {@link TenantDb.destroy}.
	 */
	readonly pool: Pool;

	/**
	 * Close the shared pool. Idempotent, and invalidates BOTH surfaces — there is
	 * one pool, so there is one teardown.
	 */
	readonly destroy: () => Promise<void>;
}

/**
 * Connect to a Databrill tenant database.
 *
 * ```ts
 * const { db, write, destroy } = createDb({
 * 	connectionString: process.env.DATABRILL_DATABASE_URL,
 * 	schema: "w123456789",
 * });
 *
 * const rows = await db.selectFrom("amazon_listing_open").selectAll().execute();
 * await destroy();
 * ```
 *
 * Both surfaces run over one `pg` pool configured so the values you get back
 * match the types you imported: `timestamptz` is a `Temporal.Instant`,
 * `timestamp` a `Temporal.PlainDateTime`, `date` a `Temporal.PlainDate`, and
 * `numeric` and `bigint` are strings. The dialect is Kysely's built-in
 * `PostgresDialect`, which never names prepared statements and is therefore
 * safe against a transaction-mode pooler with no extra configuration.
 *
 * Requires a runtime with `Temporal` — native in Deno and Node 26+, a polyfill
 * away on Node 24 and Bun. This throws immediately if it is missing.
 */
export function createDb(options: string | CreateDbOptions): TenantDb {
	requireTemporal();
	const { schema, ...poolConfig } = typeof options === "string" ? { connectionString: options } : options;
	if (schema !== undefined && !isPlainIdentifier(schema)) {
		throw new Error(
			`Invalid schema name ${JSON.stringify(schema)}: expected a plain Postgres identifier ` +
				`such as "public" or "w123456789".`,
		);
	}

	const pool = new Pool({ ...poolConfig, types: makePgTypes() });

	// `pg-pool` emits `'error'` on the POOL when an idle client fails — a
	// database restart, a pooler recycling a backend, someone running
	// `pg_terminate_backend`. `EventEmitter` throws on an unhandled `'error'`,
	// so with no listener that becomes an uncaught exception that kills the
	// customer's process, thrown from inside a library they cannot reach. This
	// package constructs the pool, so it owes the pool a listener.
	//
	// Swallowing is correct here and elsewhere would not be: an idle-client
	// failure has no caller to reject — the pool discards the client and the
	// next checkout opens a fresh connection. Callers who want visibility
	// attach their own listener to the exposed `pool`, which this does not
	// displace.
	pool.on("error", () => {});

	const dialect = new PostgresDialect({ pool });
	const plugins = [temporalParameterPlugin];
	const readBase = new Kysely<DB>({ dialect, plugins });
	const writeBase = new Kysely<WritableDB>({ dialect, plugins });

	// `as never` is the construction the Kysely documentation itself prescribes
	// for handing out a read-only view: `ReadonlyKysely` narrows `Kysely`'s
	// method signatures to error types, so the two are not mutually assignable
	// and no widening or generic trick bridges them. This is the single
	// assertion in the package, and it is load-bearing — the alternative is
	// publishing a mutable handle.
	const readable: ReadonlyKysely<DB> = readBase as never;

	const db = schema === undefined ? readable : readable.withSchema(schema);
	const write = schema === undefined ? writeBase : writeBase.withSchema(schema);

	// Teardown ends the POOL directly rather than going through either Kysely
	// instance. Kysely's driver destroy is a no-op until that instance has
	// actually acquired a connection (`if (!this.#initPromise) return`), and
	// each instance builds its own driver over the shared pool — so routing
	// teardown through `readBase` silently does nothing for a caller who only
	// ever used `write`, leaving the pool open and the process unable to exit.
	// One pool, one `end()`; calling it through both instances would `end()`
	// twice, which throws.
	//
	// The in-flight promise is memoized so a second caller waits for the pool to
	// finish draining rather than resolving early — but a REJECTED teardown is
	// cleared, so a caller whose shutdown handler catches and retries gets a
	// real second attempt instead of the same cached failure forever.
	let teardown: Promise<void> | null = null;
	function destroy(): Promise<void> {
		teardown ??= pool.end().catch((cause: unknown) => {
			teardown = null;
			throw cause;
		});
		return teardown;
	}

	return { db, write, pool, destroy };
}

/**
 * Schema names reach Kysely's identifier quoting, not a parameter, so anything
 * that is not a plain identifier is rejected rather than escaped. Callers pass
 * workspace-derived names like `w123456789`; nothing legitimate needs more.
 */
function isPlainIdentifier(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value);
}
