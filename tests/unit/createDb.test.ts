import { Cause, Effect, Either, Exit } from "effect";
import { assertEitherFailure } from "./assertEitherFailure.ts";
/**
 * Unit tests for the connection factory's non-query behaviour.
 *
 * A `pg.Pool` opens no socket until something asks it for a client, so pool
 * lifecycle and option validation are testable without a database. The value
 * round trip against real Postgres lives in `tests/integration/`.
 *
 * Public-safe: this file syncs to the public mirror.
 */

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
// @ts-types="npm:@types/pg@^8.16.0"
import { Pool } from "pg";
import { createDb, type CreateDbOptions, type TenantDb, type TenantPool } from "../../src/createDb.ts";
import { TESTING_tenantSchema1 } from "../testConstants.ts";

/** Never connected to; the pool stays idle until a query asks for a client. */
const UNUSED_URL = "postgresql://unused:unused@127.0.0.1:1/unused";

Deno.test("createDb - destroy() closes the pool for a caller who only ever used `write`", async () => {
	// The bug this pins: Kysely's driver teardown is a no-op until that instance
	// has acquired a connection, and each Kysely instance builds its own driver
	// over the shared pool. Routing teardown through the read handle therefore
	// did nothing at all for an ingestion script that only wrote — the pool
	// stayed open, and the process could not exit.
	const tenant = createInspectedDb(UNUSED_URL);
	tenant.write.insertInto("brand_config_ontology_metadata").values({
		property: "x",
		valueType: "STRING",
		appliesTo: "BOTH",
	}).compile();

	await Effect.runPromise(tenant.destroy());
	assert(tenant.pool.ended, "destroy() must end the shared pool even when the read surface was never used");
});

Deno.test("createDb - destroy() closes the pool for a caller who only ever used `db`", async () => {
	const tenant = createInspectedDb(UNUSED_URL);
	tenant.db.selectFrom("databrill_schema_version").select("version").compile();

	await Effect.runPromise(tenant.destroy());
	assert(tenant.pool.ended);
});

Deno.test("createDb - destroy() is idempotent", async () => {
	// Both surfaces share one pool, so there is one teardown; calling `end()`
	// twice on a pg pool throws.
	const tenant = createInspectedDb(UNUSED_URL);
	await Effect.runPromise(tenant.destroy());
	await Effect.runPromise(tenant.destroy());
	assert(tenant.pool.ended);
});

Deno.test("createDb - the pool has an error listener, so an idle-client failure cannot crash the process", async () => {
	// `pg-pool` emits `'error'` on the pool itself when an idle client dies —
	// a database restart, a pooler recycling a backend. `EventEmitter` throws on
	// an unhandled `'error'`, so without a listener that becomes an uncaught
	// exception thrown from inside this library.
	const tenant = createInspectedDb(UNUSED_URL);
	// `listenerCount` and `emit` are EventEmitter internals, deliberately absent
	// from TenantPool. Capture the native pool during factory construction to
	// verify the listener while keeping the owned Effect query interface separate.
	assert(tenant.nativePool instanceof Pool, "the driver pool really is a pg.Pool");
	try {
		assert(
			tenant.nativePool.listenerCount("error") > 0,
			"the library-owned pool must handle its own 'error' event",
		);
		// Emitting must not throw. Were there no listener, this line would.
		tenant.nativePool.emit("error", new Error("connection terminated unexpectedly"));
	} finally {
		// Teardown goes through `destroy()`, which is the whole reason `TenantPool`
		// declares no `end()`; it calls `pool.end()` internally and memoizes it.
		await Effect.runPromise(tenant.destroy());
	}
});

Deno.test("createDb - a caller's own 'error' listener is added, not substituted for the library's", async () => {
	// `TenantPool` publishes `on` for exactly one purpose, and its docblock makes
	// a promise about it: "Attach your own idle-client error listener; it does not
	// displace this package's." Nothing else exercises either the published `on`
	// signature or that promise, so without this test both are prose. The
	// listener `createDb` installs must remain alongside the caller's listener.
	const tenant = createInspectedDb(UNUSED_URL);
	// The captured pool exposes the EventEmitter details TenantPool omits.
	assert(tenant.nativePool instanceof Pool, "the driver pool really is a pg.Pool");
	const libraryListeners = tenant.nativePool.listenerCount("error");
	try {
		const seen: string[] = [];
		// Deliberately attached through the PUBLISHED `TenantPool`, not through the
		// narrowing above: `pg`'s own `on` overloads would type-check even if the
		// signature this package publishes were unusable to a caller.
		const published: TenantPool = tenant.pool;
		published.on("error", (error) => {
			seen.push(error.message);
		});

		assertEquals(
			tenant.nativePool.listenerCount("error"),
			libraryListeners + 1,
			"a caller's listener must be added alongside the library's, not replace it",
		);
		tenant.nativePool.emit("error", new Error("connection terminated unexpectedly"));
		assertEquals(seen, ["connection terminated unexpectedly"], "the caller's own listener must actually run");
	} finally {
		await Effect.runPromise(tenant.destroy());
	}
});

Deno.test("createDb - a schema name that is not a plain identifier is rejected", () => {
	// The schema name reaches Kysely's identifier quoting rather than a bound
	// parameter, so anything unusual is refused outright instead of escaped.
	for (const bad of ['w1"; drop table x --', "w1 w2", "1w", "", "public.other", "w1'"]) {
		assertEitherFailure(
			() => createDb({ connectionString: UNUSED_URL, schema: bad }),
			Error,
			"Invalid schema name",
		);
	}
});

Deno.test("createDb - ordinary schema names are accepted and qualify the SQL", async () => {
	const tenant = createInspectedDb({ connectionString: UNUSED_URL, schema: TESTING_tenantSchema1 });
	try {
		const compiled = tenant.db.selectFrom("databrill_schema_version").select("version").compile();
		assert(
			compiled.sql.includes(`"${TESTING_tenantSchema1}"."databrill_schema_version"`),
			`the schema must be qualified in the emitted SQL, got: ${compiled.sql}`,
		);
	} finally {
		await Effect.runPromise(tenant.destroy());
	}
});

Deno.test("createDb - a sslmode in the connection string reaches the pool as a stripped string and a resolved ssl", async () => {
	// The wiring assertion. `sslmode.test.ts` proves `resolveSslMode` computes the
	// right answer; only this proves `createDb()` puts that answer into the pool
	// config instead of forwarding the caller's original string — which `pg` would
	// then re-parse, overwriting the resolved `ssl` with its own reading.
	const tenant = createInspectedDb({
		connectionString: "postgres://u:p@127.0.0.1:1/db?application_name=x&sslmode=require",
	});
	// The captured pool exposes the driver options TenantPool omits.
	assert(tenant.nativePool instanceof Pool, "the driver pool really is a pg.Pool");
	try {
		assertEquals(tenant.nativePool.options.connectionString, "postgres://u:p@127.0.0.1:1/db?application_name=x");
		assertEquals(tenant.nativePool.options.ssl, { rejectUnauthorized: false });
	} finally {
		await Effect.runPromise(tenant.destroy());
	}
});

Deno.test("createDb - a connection string with no sslmode leaves no ssl key on the pool config at all", async () => {
	// The absence of the KEY is the assertion, not `ssl === undefined`: `pg` falls
	// back to `PGSSLMODE` only while `config.ssl` is undefined, and `createDb()`
	// spreads the `ssl` key conditionally precisely so that no key is invented for
	// a caller who never mentioned TLS. Nothing in `sslmode.test.ts` can observe
	// this — `resolveSslMode` returning `ssl: undefined` does not prove the key was
	// omitted downstream.
	const tenant = createInspectedDb(UNUSED_URL);
	assert(tenant.nativePool instanceof Pool, "the driver pool really is a pg.Pool");
	try {
		assert(!("ssl" in tenant.nativePool.options), "no ssl key may be invented, or PGSSLMODE stops working");
		assertEquals(tenant.nativePool.options.connectionString, UNUSED_URL);
	} finally {
		await Effect.runPromise(tenant.destroy());
	}
});

Deno.test("createDb - an explicit ssl option reaches the pool intact and the string cannot override it", async () => {
	// The other half of the wiring, and the unfixed bug this change fixes: `pg` merges
	// the parsed connection string OVER the config it was handed, so a caller's CA
	// used to be discarded by whatever `sslmode=` the string carried.
	// `sslmode.test.ts` proves `resolveSslMode` hands the caller's object straight
	// back; only this proves `createDb()` passes the caller's `ssl` INTO it rather
	// than `undefined`. That one-word slip reinstates the bug outright, and every
	// other test in both files stays green through it.
	const callerSsl = { ca: "PEM" };
	const tenant = createInspectedDb({ connectionString: `${UNUSED_URL}?sslmode=require`, ssl: callerSsl });
	assert(tenant.nativePool instanceof Pool, "the driver pool really is a pg.Pool");
	try {
		assertEquals(tenant.nativePool.options.ssl, callerSsl, "the caller's ssl must survive a sslmode in the string");
		assertEquals(tenant.nativePool.options.connectionString, UNUSED_URL);
	} finally {
		await Effect.runPromise(tenant.destroy());
	}
});

/** Capture the driver's pool while the factory attaches its mandatory error listener. */
function createInspectedDb(options: string | CreateDbOptions): TenantDb & { readonly nativePool: Pool } {
	let nativePool: Pool | undefined;
	const original = Pool.prototype.on;
	Pool.prototype.on = function (event, listener) {
		nativePool = this;
		return original.call(this, event, listener);
	};
	try {
		const tenant = Either.getOrThrow(createDb(options));
		assert(nativePool !== undefined, "factory must register its pool listener");
		return { ...tenant, nativePool };
	} finally {
		Pool.prototype.on = original;
	}
}

Deno.test("createDb - each synchronous call returns a separate pool without opening connections", async () => {
	const first = createDb(UNUSED_URL);
	const second = createDb(UNUSED_URL);
	assert(Either.isRight(first));
	assert(Either.isRight(second));
	try {
		assert(first.right.pool !== second.right.pool);
		assertEquals(first.right.pool.totalCount, 0);
		assertEquals(second.right.pool.totalCount, 0);
	} finally {
		await Effect.runPromise(first.right.destroy());
		await Effect.runPromise(second.right.destroy());
	}
});

Deno.test("createDb - concurrent destroy shares one failure and a later call retries", async () => {
	const tenant = createInspectedDb(UNUSED_URL);
	const originalEnd = tenant.nativePool.end.bind(tenant.nativePool);
	const pending = Promise.withResolvers<void>();
	const failure = new Error("temporary shutdown failure");
	let calls = 0;
	Object.defineProperty(tenant.nativePool, "end", {
		value: () => {
			calls++;
			return calls === 1 ? pending.promise : originalEnd();
		},
	});

	const close = tenant.destroy();
	assertEquals(calls, 0, "constructing cleanup must not start it");
	const first = Effect.runPromiseExit(close);
	const second = Effect.runPromiseExit(close);
	assertEquals(calls, 1);
	pending.reject(failure);
	for (const result of await Promise.all([first, second])) {
		assert(Exit.isFailure(result));
		assert(Cause.isFailType(result.cause));
		assertEquals(result.cause.error, failure);
	}

	await Effect.runPromise(close);
	await Effect.runPromise(close);
	assertEquals(calls, 2);
	assert(tenant.pool.ended);
});

Deno.test("createDb - pool query captures synchronous driver throws and rejection without running early", async () => {
	const tenant = createInspectedDb(UNUSED_URL);
	const failure = new Error("query failure");
	let calls = 0;
	Object.defineProperty(tenant.nativePool, "query", {
		value: () => {
			calls++;
			if (calls === 1) {
				throw failure;
			}
			return Promise.reject(failure);
		},
	});
	try {
		const query = tenant.pool.query("SELECT 1");
		assertEquals(calls, 0);
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await Effect.runPromiseExit(query);
			assert(Exit.isFailure(result));
			assert(Cause.isFailType(result.cause));
			assertEquals(result.cause.error, failure);
		}
		assertEquals(calls, 2);
	} finally {
		await Effect.runPromise(tenant.destroy());
	}
});
