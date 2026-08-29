/**
 * Unit tests for the connection factory's non-query behaviour.
 *
 * A `pg.Pool` opens no socket until something asks it for a client, so pool
 * lifecycle and option validation are testable without a database. The value
 * round trip against real Postgres lives in `tests/integration/`.
 *
 * Public-safe: this file syncs to the public mirror.
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
// @ts-types="npm:@types/pg@^8.16.0"
import { Pool } from "pg";
import { createDb, type TenantPool } from "../../src/createDb.ts";
import { TESTING_tenantSchema1 } from "../testConstants.ts";

/** Never connected to; the pool stays idle until a query asks for a client. */
const UNUSED_URL = "postgresql://unused:unused@127.0.0.1:1/unused";

Deno.test("createDb - destroy() closes the pool for a caller who only ever used `write`", async () => {
	// The bug this pins: Kysely's driver teardown is a no-op until that instance
	// has acquired a connection, and each Kysely instance builds its own driver
	// over the shared pool. Routing teardown through the read handle therefore
	// did nothing at all for an ingestion script that only wrote — the pool
	// stayed open, and the process could not exit.
	const tenant = createDb(UNUSED_URL);
	tenant.write.insertInto("brand_config_ontology_metadata").values({
		property: "x",
		valueType: "STRING",
		appliesTo: "BOTH",
	}).compile();

	await tenant.destroy();
	assert(tenant.pool.ended, "destroy() must end the shared pool even when the read surface was never used");
});

Deno.test("createDb - destroy() closes the pool for a caller who only ever used `db`", async () => {
	const tenant = createDb(UNUSED_URL);
	tenant.db.selectFrom("databrill_schema_version").select("version").compile();

	await tenant.destroy();
	assert(tenant.pool.ended);
});

Deno.test("createDb - destroy() is idempotent", async () => {
	// Both surfaces share one pool, so there is one teardown; calling `end()`
	// twice on a pg pool throws.
	const tenant = createDb(UNUSED_URL);
	await tenant.destroy();
	await tenant.destroy();
	assert(tenant.pool.ended);
});

Deno.test("createDb - the pool has an error listener, so an idle-client failure cannot crash the process", async () => {
	// `pg-pool` emits `'error'` on the pool itself when an idle client dies —
	// a database restart, a pooler recycling a backend. `EventEmitter` throws on
	// an unhandled `'error'`, so without a listener that becomes an uncaught
	// exception thrown from inside this library.
	const tenant = createDb(UNUSED_URL);
	// `listenerCount` and `emit` are `EventEmitter` internals, deliberately absent
	// from the published `TenantPool` — they prove an internal guarantee this
	// package does not promise callers. Narrowing back to the concrete class is how
	// this test reaches them without widening the published type, and it also
	// checks the claim `TenantDb.pool`'s docblock makes: the value really is `pg`'s
	// `Pool`, and only the published type is narrowed. A cast would assert that
	// claim; `instanceof` verifies it.
	assert(tenant.pool instanceof Pool, "the exposed pool really is a pg.Pool");
	try {
		assert(tenant.pool.listenerCount("error") > 0, "the library-owned pool must handle its own 'error' event");
		// Emitting must not throw. Were there no listener, this line would.
		tenant.pool.emit("error", new Error("connection terminated unexpectedly"));
	} finally {
		// Teardown goes through `destroy()`, which is the whole reason `TenantPool`
		// declares no `end()`; it calls `pool.end()` internally and memoizes it.
		await tenant.destroy();
	}
});

Deno.test("createDb - a caller's own 'error' listener is added, not substituted for the library's", async () => {
	// `TenantPool` publishes `on` for exactly one purpose, and its docblock makes
	// a promise about it: "Attach your own idle-client error listener; it does not
	// displace this package's." Nothing else exercises either the published `on`
	// signature or that promise, so without this test both are prose. The
	// swallowing listener `createDb` installs is what makes the promise load
	// bearing — a caller who lost it would get no visibility at all.
	const tenant = createDb(UNUSED_URL);
	// Narrowed for the same reason as the test above: `listenerCount` and `emit`
	// are `EventEmitter` internals `TenantPool` deliberately does not publish.
	assert(tenant.pool instanceof Pool, "the exposed pool really is a pg.Pool");
	const libraryListeners = tenant.pool.listenerCount("error");
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
			tenant.pool.listenerCount("error"),
			libraryListeners + 1,
			"a caller's listener must be added alongside the library's, not replace it",
		);
		tenant.pool.emit("error", new Error("connection terminated unexpectedly"));
		assertEquals(seen, ["connection terminated unexpectedly"], "the caller's own listener must actually run");
	} finally {
		await tenant.destroy();
	}
});

Deno.test("createDb - a schema name that is not a plain identifier is rejected", () => {
	// The schema name reaches Kysely's identifier quoting rather than a bound
	// parameter, so anything unusual is refused outright instead of escaped.
	for (const bad of ['w1"; drop table x --', "w1 w2", "1w", "", "public.other", "w1'"]) {
		assertThrows(() => createDb({ connectionString: UNUSED_URL, schema: bad }), Error, "Invalid schema name");
	}
});

Deno.test("createDb - ordinary schema names are accepted and qualify the SQL", async () => {
	const tenant = createDb({ connectionString: UNUSED_URL, schema: TESTING_tenantSchema1 });
	try {
		const compiled = tenant.db.selectFrom("databrill_schema_version").select("version").compile();
		assert(
			compiled.sql.includes(`"${TESTING_tenantSchema1}"."databrill_schema_version"`),
			`the schema must be qualified in the emitted SQL, got: ${compiled.sql}`,
		);
	} finally {
		await tenant.destroy();
	}
});

Deno.test("createDb - a connection string and an options object behave the same", async () => {
	const fromString = createDb(UNUSED_URL);
	const fromOptions = createDb({ connectionString: UNUSED_URL });
	try {
		assertEquals(
			fromString.db.selectFrom("databrill_schema_version").select("version").compile().sql,
			fromOptions.db.selectFrom("databrill_schema_version").select("version").compile().sql,
		);
	} finally {
		await fromString.destroy();
		await fromOptions.destroy();
	}
});
