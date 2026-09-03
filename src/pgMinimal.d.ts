/**
 * The types for this package's `pg` import — hand-written, and deliberately not
 * `@types/pg`.
 *
 * ## Why this file exists
 *
 * JSR generates the published npm-compat `package.json` on its own servers, from
 * a scan of the source. Every registry specifier it finds becomes a `dependencies`
 * entry — and an inline `@ts-types` directive naming `npm:@types/pg` is a registry
 * specifier. So taking `@types/pg` out of `deno.json`'s `imports` did not take it
 * out of the published manifest: `0.1.5` shipped depending on `@types/pg@^8.16.0`,
 * a range that by then existed nowhere but in those two directives. Pointing them
 * at a relative path instead leaves nothing for the scan to find.
 *
 * That is not a cosmetic difference for a consumer. `@types/pg` pulls in
 * `@types/node`, and floats `pg-protocol@*` and `pg-types@^2.2.0` — the latter two
 * resolved independently of what `pg` itself pins, which is how a consumer ends up
 * with two copies of each and the duplicate-declaration errors that follow.
 *
 * ## What is safe to leave out, and why
 *
 * This is not an attempt to re-describe `pg`. It types the four things `src/`
 * actually does with the driver, and nothing else:
 *
 * - `new Pool(config)` in `createDb.ts`
 * - `pool.on("error", …)` in `createDb.ts`
 * - handing that pool to Kysely's `PostgresDialect`
 * - `types.getTypeParser(oid, format)` in `pgTypeParsers.ts`
 *
 * Anything a caller might reach for that is missing here is missing on purpose:
 * `createDb()` hands out {@link TenantPool}, not this, so nothing below is
 * published or reachable from outside the package.
 *
 * ## The two shapes this has to satisfy, and the check that proves it
 *
 * {@link Pool} has to be structurally assignable to both Kysely's
 * `PostgresPool` and this package's own `TenantPool` — the two places a real
 * `pg.Pool` is used as something else. `src/createDb.ts` does both, handing the
 * pool to `new PostgresDialect({ pool })` and returning it as `TenantDb.pool`,
 * so a member that drifts out of shape fails `deno task check` there rather
 * than at a customer's first query. No test restates that check.
 *
 * What no type check can prove is the other direction: that these declarations
 * still match the RUNTIME `pg`. `tests/integration/createDbRoundTrip.test.ts`
 * connects for real and is what covers that.
 */

import type { PostgresPoolClient } from "kysely";

/**
 * What {@link Pool}'s constructor accepts.
 *
 * `types` is spelled out because this package sets it and the shape it sets has
 * to be checked. Every other option is admitted through the index signature
 * rather than restated: the reviewed list of option names this package promises
 * a customer is `CreateDbOptions` in `createDb.ts`, that is what checks a caller,
 * and `createDb()` forwards nothing it did not first accept there. Restating the
 * list here would create a second copy to drift, and a copy that answers a
 * different question — `CreateDbOptions` is what this package promises, whereas
 * this is what the driver takes, and the two sets are not the same set.
 */
export interface PoolConfig {
	/** The per-pool parser table `createDb()` installs; see `makePgTypes()`. */
	readonly types?: { readonly getTypeParser: (oid: number, format?: "text" | "binary") => unknown };
	readonly [option: string]: unknown;
}

/** What {@link Pool.query} resolves to. Assignable to this package's `TenantPoolResult`. */
export interface QueryResult {
	readonly command: string;
	readonly rowCount: number | null;
	readonly rows: Record<string, unknown>[];
}

/**
 * `pg`'s connection pool, narrowed to what this package uses.
 *
 * `connect()` and `options` are here only because Kysely's `PostgresPool`
 * requires them; `src/` never calls either. `end()` is called, by `destroy()`.
 */
export declare class Pool {
	constructor(config?: PoolConfig);

	readonly totalCount: number;
	readonly idleCount: number;
	readonly waitingCount: number;
	readonly ended: boolean;
	readonly options: object;

	connect(): Promise<PostgresPoolClient>;
	end(): Promise<void>;
	query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
	on(event: "error", listener: (error: Error) => void): this;
}

/**
 * `pg`'s default parser table.
 *
 * Only `getTypeParser` is declared: `setTypeParser` is process-global, and this
 * package overrides parsing per pool precisely so it never touches it. Leaving it
 * undeclared means a future edit that reaches for it fails the type check instead
 * of quietly rewriting parsing for every pool in the customer's process.
 */
export declare const types: {
	getTypeParser(oid: number, format?: "text" | "binary"): unknown;
};
