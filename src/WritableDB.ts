import type { DB } from "./db.ts";
import type { WRITABLE_TABLE_NAMES } from "./WRITABLE_TABLE_NAMES.ts";

/** The name of a customer-writable tenant table. */
export type WritableTableName = typeof WRITABLE_TABLE_NAMES[number];

/**
 * The write surface: the readable schema narrowed to the writable tables.
 *
 * This is a compile-time affordance, not a security boundary. The enforceable
 * boundary is the grants held by the connecting database role.
 *
 * `Pick<DB, WritableTableName>` is also the subset guarantee: a writable table
 * missing from `DB` is a type error here rather than a lie shipped to
 * customers. That check used to live in generated output, so it only bit after
 * someone regenerated; here `deno task check` runs it every time.
 *
 * Note the import above: `WRITABLE_TABLE_NAMES` is a VALUE, imported with
 * `import type` because it is used only in `typeof` position. That is legal,
 * and it is what keeps this module fully erasable — the emitted JavaScript
 * contains no import of `WRITABLE_TABLE_NAMES.ts` at all.
 */
export type WritableDB = Pick<DB, WritableTableName>;
