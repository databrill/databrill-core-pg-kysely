/**
 * Unit tests for the driver parser wiring and the query-parameter plugin.
 *
 * Both exist for the same reason: `pg`'s defaults contradict the published
 * types in both directions. Reads would hand back `Date` objects; writes would
 * hand `pg` a Temporal object it serializes with `JSON.stringify`. These tests
 * pin the wiring without needing a database — the round trip against real
 * Postgres is covered in `tests/integration/`.
 *
 * Public-safe: this file syncs to the public mirror.
 */

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { Kysely, PostgresDialect, sql } from "kysely";
// @ts-types="npm:@types/pg@^8.16.0"
import { Pool, types as pgTypes } from "pg";
import { makePgTypes, pgTypeParsers } from "../../src/pgTypeParsers.ts";
import { temporalParameterPlugin } from "../../src/temporalParameterPlugin.ts";
import type { DB } from "../../src/db.ts";
import type { WritableDB } from "../../src/WritableDB.ts";

/** `date`, `timestamp without time zone`, `timestamp with time zone`. */
const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;

Deno.test("pgTypeParsers - covers exactly the three date/time OIDs", () => {
	assertEquals(Object.keys(pgTypeParsers).map(Number).sort((a, b) => a - b), [
		OID_DATE,
		OID_TIMESTAMP,
		OID_TIMESTAMPTZ,
	]);
});

Deno.test("pgTypeParsers - each OID produces its documented Temporal type", () => {
	const date = pgTypeParsers[OID_DATE]?.("2026-08-10");
	const timestamp = pgTypeParsers[OID_TIMESTAMP]?.("2026-08-10 19:18:27.361");
	const timestamptz = pgTypeParsers[OID_TIMESTAMPTZ]?.("2026-08-10 19:18:27.361+00");

	assertEquals(Object.prototype.toString.call(date), "[object Temporal.PlainDate]");
	assertEquals(Object.prototype.toString.call(timestamp), "[object Temporal.PlainDateTime]");
	assertEquals(Object.prototype.toString.call(timestamptz), "[object Temporal.Instant]");
});

Deno.test("makePgTypes - overrides the date/time OIDs and delegates everything else", () => {
	const types = makePgTypes();
	assertEquals(types.getTypeParser(OID_TIMESTAMPTZ), pgTypeParsers[OID_TIMESTAMPTZ]);
	assertEquals(types.getTypeParser(OID_DATE), pgTypeParsers[OID_DATE]);

	// 23 is int4. Whatever pg does with it, we must do the identical thing.
	assertEquals(types.getTypeParser(23), pgTypes.getTypeParser(23));
});

Deno.test("makePgTypes - does not mutate pg's global parser registry", () => {
	// The whole point of configuring `types` per-Pool is that another pool in
	// the same process is unaffected. If this ever regresses, a customer's
	// unrelated pool starts returning Temporal values it never asked for.
	const before = pgTypes.getTypeParser(OID_TIMESTAMPTZ);
	makePgTypes();
	assertEquals(pgTypes.getTypeParser(OID_TIMESTAMPTZ), before);
	assert(pgTypes.getTypeParser(OID_TIMESTAMPTZ) !== pgTypeParsers[OID_TIMESTAMPTZ]);
});

/** A Kysely instance that compiles SQL without ever opening a connection. */
function compileOnlyDb(): Kysely<DB> {
	return new Kysely<DB>({
		dialect: new PostgresDialect({ pool: new Pool({ connectionString: "postgres://unused/unused" }) }),
		plugins: [temporalParameterPlugin],
	});
}

/** The same, over the customer-writable subset, for exercising the write path. */
function compileOnlyWritableDb(): Kysely<WritableDB> {
	return new Kysely<WritableDB>({
		dialect: new PostgresDialect({ pool: new Pool({ connectionString: "postgres://unused/unused" }) }),
		plugins: [temporalParameterPlugin],
	});
}

Deno.test("temporalParameterPlugin - renders a Temporal parameter to text", () => {
	const compiled = compileOnlyDb()
		.selectFrom("databrill_schema_version")
		.select("component")
		.where("updatedAt", "=", Temporal.Instant.from("2026-08-10T19:18:27.361Z"))
		.compile();
	assertEquals(compiled.parameters, ["2026-08-10T19:18:27.361Z"]);
});

Deno.test("temporalParameterPlugin - rewrites values inside an `in` list", () => {
	// `in` lists compile to a PrimitiveValueListNode, a separate node kind that
	// a ValueNode-only transformer would silently miss.
	const compiled = compileOnlyDb()
		.selectFrom("databrill_schema_version")
		.select("component")
		.where("updatedAt", "in", [
			Temporal.Instant.from("2026-08-10T00:00:00Z"),
			Temporal.Instant.from("2026-08-11T00:00:00Z"),
		])
		.compile();
	assertEquals(compiled.parameters, ["2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z"]);
});

Deno.test("temporalParameterPlugin - renders Temporal values nested in an array parameter", () => {
	// `= ANY($1)` is one parameter holding an array. A check against the array
	// object itself finds no Temporal value and lets every element reach pg
	// unrendered, which is a runtime error the types cannot catch.
	const compiled = compileOnlyDb()
		.selectFrom("databrill_schema_version")
		.select("component")
		.where(sql<boolean>`"updatedAt" = ANY(${[
			Temporal.Instant.from("2026-08-10T00:00:00Z"),
			Temporal.Instant.from("2026-08-11T00:00:00Z"),
		]})`)
		.compile();
	assertEquals(compiled.parameters, [["2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z"]]);
});

Deno.test("temporalParameterPlugin - covers values inside a raw sql fragment", () => {
	// A raw fragment's parameters land as ordinary ValueNodes, so the same two
	// node kinds cover them. This is also the only route by which an exotic
	// Temporal type can reach the driver, since the fragment is untyped.
	const compiled = compileOnlyDb()
		.selectFrom("databrill_schema_version")
		.select("component")
		.where(sql<boolean>`"updatedAt" > ${Temporal.Instant.from("2026-08-10T00:00:00Z")}`)
		.compile();
	assertEquals(compiled.parameters, ["2026-08-10T00:00:00Z"]);
});

Deno.test("temporalParameterPlugin - leaves non-Temporal parameters untouched", () => {
	const compiled = compileOnlyDb()
		.selectFrom("databrill_schema_version")
		.select("component")
		.where("component", "=", "tenant-schema")
		.where("version", "in", ["0.1.0", "0.2.0"])
		.compile();
	assertEquals(compiled.parameters, ["tenant-schema", "0.1.0", "0.2.0"]);
});

Deno.test("temporalParameterPlugin - a written Temporal value is rendered, a written ISO string passes through", () => {
	// The `| string` in the column aliases applies to the INSERT and UPDATE
	// slots. A `where` comparison is typed against the SELECT slot, so it takes
	// a Temporal value — that is Kysely's rule, not something this package
	// chose, and it is why the string case has to be exercised through a write.
	const instantWrite = compileOnlyWritableDb()
		.updateTable("brand_config_ontology_metadata")
		.set({ updatedAt: Temporal.Instant.from("2026-08-10T19:18:27.361Z") })
		.compile();
	assertEquals(instantWrite.parameters, ["2026-08-10T19:18:27.361Z"]);

	const stringWrite = compileOnlyWritableDb()
		.updateTable("brand_config_ontology_metadata")
		.set({ updatedAt: "2026-08-10T19:18:27.361Z" })
		.compile();
	assertEquals(stringWrite.parameters, ["2026-08-10T19:18:27.361Z"]);
});
