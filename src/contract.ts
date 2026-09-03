/**
 * Constants entry point: `@databrill/core-pg-kysely/contract`.
 *
 * The schema contract as runtime values, with no dependency on `pg` or on a
 * live connection. `SCHEMA_VERSION` is what a database is compared against,
 * `SCHEMA_HASH` identifies which generated surface a build carries,
 * `WRITABLE_TABLE_NAMES` is the writable half of the surface as data you can
 * iterate, and `TABLE_NAMES` and `VIEW_NAMES` are every published table and
 * every published view as that same kind of data — together, the whole of
 * `keyof DB`.
 *
 * These are here rather than in `./types` because that entry point is types
 * only, and here rather than only at the package root because the root pulls in
 * `pg` and its whole dependency tree. Reading the contract should not cost a
 * database driver.
 *
 * A constant belongs in this module when it describes the published schema
 * contract. One that does not belongs somewhere else — that is the whole point
 * of naming this `contract` rather than `constants`.
 *
 * `TABLE_NAMES` and `VIEW_NAMES` meet that rule directly: they are the
 * published relation set stated as data, not a convenience list assembled for
 * one caller, and the table/view split they keep is the same distinction the
 * contract asks customers to act on.
 *
 * @module
 */

export { WRITABLE_TABLE_NAMES } from "./WRITABLE_TABLE_NAMES.ts";
export { TABLE_NAMES, VIEW_NAMES } from "./relationNames.ts";
export { SCHEMA_HASH, SCHEMA_VERSION } from "./schemaVersion.ts";
