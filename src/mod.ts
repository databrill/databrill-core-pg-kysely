/**
 * `@databrill/core-pg-kysely` — typed, read-mostly access to a Databrill tenant
 * database.
 *
 * ```ts
 * import { checkSchemaCompatibility, createDb } from "@databrill/core-pg-kysely";
 *
 * const { db, write, destroy } = createDb({
 * 	connectionString: Deno.env.get("DATABRILL_DATABASE_URL"),
 * 	schema: "w100000660",
 * });
 *
 * const compatibility = await checkSchemaCompatibility(db);
 * if (compatibility.level === "error") {
 * 	throw new Error(compatibility.message);
 * }
 *
 * const listings = await db
 * 	.selectFrom("amazon_listing_open")
 * 	.select(["sku", "asin"])
 * 	.limit(10)
 * 	.execute();
 *
 * await destroy();
 * ```
 *
 * `db` covers every published table and view and rejects writes at compile
 * time; `write` covers the tables customers are meant to write. That split is a
 * type-level affordance — the enforceable boundary is the grants held by your
 * database role.
 *
 * Import from `@databrill/core-pg-kysely/types` instead if you only need the
 * schema types and no connection.
 */

// The exported surface is deliberately small: everything here is something a
// customer has a reason to reach for. The internals that support them —
// `compareSchemaVersions`, the individual Temporal parsers, `isTemporalValue`,
// `temporalToPostgres` — stay unexported, because every name published from a
// 0.x package is a name that has to keep working.

export { createDb } from "./createDb.ts";
export type { CreateDbOptions, TenantDb } from "./createDb.ts";
export { checkSchemaCompatibility } from "./checkSchemaCompatibility.ts";
export type { SchemaCompatibility, SchemaCompatibilityLevel } from "./checkSchemaCompatibility.ts";

// For customers who build their own dialect instead of using `createDb`: these
// three are what make the published types true, on the read side and the write
// side respectively.
export { makePgTypes, pgTypeParsers } from "./pgTypeParsers.ts";
export { temporalParameterPlugin } from "./temporalParameterPlugin.ts";
export { requireTemporal, UnrepresentableTemporalValueError } from "./temporalValues.ts";

export type * from "./db.ts";
export type { InstantColumn, PlainDateColumn, PlainDateTimeColumn } from "./temporalColumns.ts";
export type { WritableDB, WritableTableName } from "./writableTables.ts";
export { WRITABLE_TABLE_NAMES } from "./writableTables.ts";
export { SCHEMA_HASH, SCHEMA_VERSION } from "./schemaVersion.ts";
