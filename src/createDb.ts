import { Kysely, PostgresDialect } from "kysely";
import type { ReadonlyKysely } from "kysely/readonly";
// @ts-types="./pgMinimal.d.ts"
import { Pool } from "pg";
import type { DB } from "./db.ts";
import { makePgTypes } from "./pgTypeParsers.ts";
import { resolveSslMode } from "./sslmode.ts";
import { temporalParameterPlugin } from "./temporalParameterPlugin.ts";
import { requireTemporal } from "./temporalValues.ts";
import type { WritableDB } from "./WritableDB.ts";

/**
 * Options for {@link createDb}.
 *
 * Declared outright rather than derived from `pg`'s `PoolConfig`, so `@types/pg`
 * — and, through its `ssl` and `stream` fields, `@types/node` — stays out of this
 * package's published types. A derived interface also has no version story: a
 * DefinitelyTyped PATCH release silently widens a `0.x` contract. That is not
 * hypothetical. `enableChannelBinding`, `sslnegotiation` and `pipeline` are
 * absent from `@types/pg@8.21.0` and present in `8.23.1`, so `extends
 * Omit<PoolConfig, "types">` would have published three new option names on a
 * lockfile refresh, with nothing to review and no version to bump.
 *
 * Every field here is one `createDb()` genuinely forwards to `new Pool()` and
 * one a customer of a tenant database client has a reason to set. Adding an
 * optional field later is a compatible change and removing one is not, so this
 * starts narrow.
 *
 * Deliberately excluded, and why — this list is the decision, so a future reader
 * weighing whether to add a field reads it here:
 *
 * - `types` — the package owns it; see {@link makePgTypes}.
 * - `Client`, `stream`, `log`, `Promise`, `onConnect`, `verify` —
 *   driver-internal escape hatches. Handing a customer `Client` lets them swap
 *   the client class and silently lose the type parsers that make the published
 *   types true, which is the single thing this package exists to guarantee.
 * - `keepAlive`, `keepAliveInitialDelayMillis`, `options`, `client_encoding`,
 *   `fallback_application_name` — plausible but unused, and every name published
 *   from a 0.x package is a name that has to keep working. Add on request.
 * - `enableChannelBinding`, `sslnegotiation`, `pipeline` — the very options whose
 *   arrival between `@types/pg@8.21.0` and `8.23.1` is the evidence above. They
 *   are declared by the types this package currently resolves, but the runtime
 *   floor is `pg@^8.16.3`, which does not have them, and DefinitelyTyped is not
 *   what decides that. Declaring them would promise options this package cannot
 *   promise `pg` accepts.
 */
export interface CreateDbOptions {
	// where to connect
	readonly connectionString?: string;
	readonly host?: string;
	readonly port?: number;
	readonly user?: string;
	readonly password?: string | (() => string | Promise<string>);
	readonly database?: string;
	readonly ssl?: boolean | TenantTlsOptions;

	// pool sizing and lifetime
	readonly max?: number;
	readonly min?: number;
	readonly idleTimeoutMillis?: number;
	readonly connectionTimeoutMillis?: number;
	readonly maxUses?: number;
	readonly maxLifetimeSeconds?: number;
	readonly allowExitOnIdle?: boolean;

	// what the server is told
	readonly application_name?: string;
	readonly statement_timeout?: number | false;
	readonly query_timeout?: number;
	readonly idle_in_transaction_session_timeout?: number;
	readonly lock_timeout?: number;

	// this package's own
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
 * The TLS options this package forwards, declared so `node:tls` stays out of the
 * published types.
 *
 * One consequence is reviewer-visible and deliberate: `ca`, `cert` and `key` are
 * `string`, while `pg` itself accepts `string | Buffer | (string | Buffer)[]`. A
 * customer holding a CA as a `Buffer` must `.toString()` it. Admitting `Buffer`
 * would re-import `@types/node`, which is half of what declaring these options
 * removes.
 */
export interface TenantTlsOptions {
	readonly rejectUnauthorized?: boolean;
	readonly ca?: string;
	readonly cert?: string;
	readonly key?: string;
	readonly servername?: string;
}

/**
 * The subset of the underlying `pg` pool this package exposes.
 *
 * Declared structurally rather than as `pg`'s `Pool` so `@types/pg` stays out of
 * the published types. `connect()` and `end()` are deliberately absent: teardown
 * goes through `destroy()`, and a checked-out client the caller has to remember
 * to release is not an escape hatch worth publishing.
 *
 * Kysely's own `PostgresPool` was considered and rejected: it is
 * `{ Client?; connect(); end(); options }` — exactly the two members this
 * package tells callers not to use, and none of the three it tells them they
 * may.
 */
export interface TenantPool {
	readonly totalCount: number;
	readonly idleCount: number;
	readonly waitingCount: number;
	/** True once the pool has been drained by `destroy()`. */
	readonly ended: boolean;
	/** Run SQL this package cannot express. */
	query(text: string, values?: readonly unknown[]): Promise<TenantPoolResult>;
	/** Attach your own idle-client error listener; it does not displace this package's. */
	on(event: "error", listener: (error: Error) => void): void;
}

/** What {@link TenantPool.query} resolves to. */
export interface TenantPoolResult {
	readonly command: string;
	readonly rowCount: number | null;
	readonly rows: readonly Record<string, unknown>[];
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
	 * {@link TenantDb.destroy} — which {@link TenantPool} now enforces rather than
	 * merely asking for, since it declares no `end()` at all. The value really is
	 * `pg`'s `Pool`; only the published type is narrowed.
	 */
	readonly pool: TenantPool;

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
 * A `sslmode` in the connection string is read here and applied with libpq's
 * meanings rather than `pg`'s — `require` means encrypted, not verified — and
 * an explicit `ssl` option wins over the string. See the README's "TLS and
 * `sslmode`" section.
 *
 * Requires `Temporal`, from the runtime itself or from
 * `temporal-polyfill/global`. This throws immediately if it is missing.
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

	// `sslmode` is read off the connection string here and applied with libpq's
	// meanings rather than `pg`'s; see `resolveSslMode`. The REWRITTEN string is
	// what reaches the driver, because `pg` merges the parsed connection string
	// over the config it was handed — leaving `sslmode=` in place would let the
	// string overwrite both what this resolved and an `ssl` the caller passed.
	//
	// Both keys are spread conditionally, so a connection string this does not
	// touch — and an absent `sslmode` — leave the pool config exactly as the
	// caller wrote it, with no `ssl` key invented. `pg@8.23.0` would not notice
	// the difference on its own: `connection-parameters.js:85` falls back to
	// `PGSSLMODE` whenever `typeof config.ssl === "undefined"`, so a
	// present-and-`undefined` key behaves like an absent one there. Not writing
	// the key is what keeps that true regardless of how the check is spelled.
	const tls = typeof poolConfig.connectionString === "string"
		? resolveSslMode(poolConfig.connectionString, poolConfig.ssl)
		: undefined;
	const connectionStringOption = tls === undefined ? {} : { connectionString: tls.connectionString };
	const sslOption = tls === undefined || tls.ssl === undefined ? {} : { ssl: tls.ssl };

	const pool = new Pool({ ...poolConfig, ...connectionStringOption, ...sslOption, types: makePgTypes() });

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
