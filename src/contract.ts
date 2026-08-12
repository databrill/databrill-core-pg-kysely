/**
 * Constants entry point: `@databrill/core-pg-kysely/contract`.
 *
 * The schema contract as runtime values, with no dependency on `pg` or on a
 * live connection. `SCHEMA_VERSION` is what a database is compared against,
 * `SCHEMA_HASH` identifies which generated surface a build carries, and
 * `WRITABLE_TABLE_NAMES` is the writable half of the surface as data you can
 * iterate.
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
 * @module
 */

export { WRITABLE_TABLE_NAMES } from "./WRITABLE_TABLE_NAMES.ts";
export { SCHEMA_HASH, SCHEMA_VERSION } from "./schemaVersion.ts";
