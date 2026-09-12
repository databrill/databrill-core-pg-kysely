/**
 * `@databrill/core-pg-kysely` — typed, read-mostly access to a Databrill tenant
 * database.
 *
 * ```ts
 * import { Effect, Either } from "effect";
 * import { checkSchemaCompatibility, createDb } from "@databrill/core-pg-kysely";
 *
 * const { db, write, destroy } = Either.getOrThrowWith(
 * 	createDb({
 * 		connectionString: Deno.env.get("DATABRILL_DATABASE_URL"),
 * 		schema: "w123456789",
 * 	}),
 * 	(error) => error,
 * );
 *
 * try {
 * 	const compatibility = await Effect.runPromise(checkSchemaCompatibility(db));
 * 	if (compatibility.level === "error") {
 * 		throw new Error(compatibility.message);
 * 	}
 *
 * 	const listings = await db
 * 		.selectFrom("amazon_listing_open")
 * 		.select(["sku", "asin"])
 * 		.limit(10)
 * 		.execute();
 *
 * } finally {
 * 	await Effect.runPromise(destroy());
 * }
 * ```
 *
 * `db` covers every published table and view and rejects writes at compile
 * time; `write` covers the tables customers are meant to write. That split is a
 * type-level check — the enforceable boundary is the grants held by your
 * database role.
 *
 * @module
 */

// The exported surface is deliberately small: everything here is something a
// customer has a reason to reach for. The internals that support them —
// `compareSchemaVersions`, the individual Temporal parsers, `isTemporalValue`,
// `temporalToPostgres` — stay unexported, because every name published from a
// 0.x package is a name that has to keep working.
//
// `TenantTlsOptions`, `TenantPool`, `TenantPoolResult` and `PgTypeOverrides` are
// here under that same rule rather than in spite of it: each is this package's
// own declaration standing in for a type that used to come from `@types/pg`, and
// each is reachable from a signature a customer has to be able to write down.
// An unexported one would be a member of a public interface that nobody can
// name.

export { checkSchemaCompatibility } from "./checkSchemaCompatibility.ts";
export type { SchemaCompatibility, SchemaCompatibilityLevel } from "./checkSchemaCompatibility.ts";
export { createDb } from "./createDb.ts";
export type { CreateDbOptions, TenantDb, TenantPool, TenantPoolResult, TenantTlsOptions } from "./createDb.ts";

// For customers who build their own dialect instead of using `createDb`: these
// three are what make the published types true, on the read side and the write
// side respectively.
export { makePgTypes, pgTypeParsers } from "./pgTypeParsers.ts";
export type { PgTypeOverrides } from "./pgTypeParsers.ts";
export { temporalParameterPlugin } from "./temporalParameterPlugin.ts";
export { requireTemporal, UnrepresentableTemporalValueError } from "./temporalValues.ts";

export type * from "./db.ts";
export type { InstantColumn, PlainDateColumn, PlainDateTimeColumn } from "./temporalColumns.ts";
export { WRITABLE_TABLE_NAMES } from "./WRITABLE_TABLE_NAMES.ts";
export type { WritableDB, WritableTableName } from "./WritableDB.ts";
// `DB` names every relation Databrill can provision; a given workspace holds a
// subset of them. These two lists are what a customer diffs against their own
// schema to find out which of those names their database actually has.
export { TABLE_NAMES, VIEW_NAMES } from "./relationNames.ts";
export { SCHEMA_HASH, SCHEMA_VERSION } from "./schemaVersion.ts";
