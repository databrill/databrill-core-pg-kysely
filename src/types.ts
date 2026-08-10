/**
 * Types-only entry point: `@databrill/core-pg-kysely/types`.
 *
 * Everything the schema contract consists of, with no runtime dependency on
 * `pg` or on a live connection. Import from here when you are typing rows,
 * writing helpers over the schema, or building your own Kysely instance; import
 * from the package root when you also want {@link createDb}.
 */

export type * from "./db.ts";
export type { InstantColumn, PlainDateColumn, PlainDateTimeColumn } from "./temporalColumns.ts";
export type { WritableDB, WritableTableName } from "./writableTables.ts";
export { WRITABLE_TABLE_NAMES } from "./writableTables.ts";
export { SCHEMA_HASH, SCHEMA_VERSION } from "./schemaVersion.ts";
