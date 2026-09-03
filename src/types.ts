/**
 * Types entry point: `@databrill/core-pg-kysely/types`.
 *
 * Type-only, and literally so: every export here is erased, so importing this
 * module emits no JavaScript and pulls in no dependency — not `pg`, not
 * `kysely`, nothing. Import from here when you are typing rows, writing helpers
 * over the schema, or building your own Kysely instance.
 *
 * For the contract as runtime values — `SCHEMA_VERSION`, `SCHEMA_HASH`,
 * `WRITABLE_TABLE_NAMES`, `TABLE_NAMES` and `VIEW_NAMES` — import
 * `@databrill/core-pg-kysely/contract`, which is also free of `pg`. For a connection, import the package root, which is
 * where {@link createDb} and its driver dependencies live.
 *
 * @module
 */

export type * from "./db.ts";
export type { InstantColumn, PlainDateColumn, PlainDateTimeColumn } from "./temporalColumns.ts";
export type { WritableDB, WritableTableName } from "./WritableDB.ts";
