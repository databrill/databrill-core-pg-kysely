/**
 * Unit tests for the generated writable-table surface.
 *
 * `WRITABLE_TABLE_NAMES` is derived from the schema DSL's per-table read/write
 * flag, and `WritableDB` is `Pick<DB, WritableTableName>` — so the subset
 * relationship is already enforced by the type checker at generation time.
 * What is worth pinning at runtime is that the list is non-empty, deduplicated,
 * stably ordered, and that the type actually narrows: a regeneration that
 * accidentally emitted every table would still type-check.
 *
 * Public-safe: this file syncs to the public mirror.
 */

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import type { DB } from "../../src/db.ts";
import { WRITABLE_TABLE_NAMES, type WritableDB, type WritableTableName } from "../../src/writableTables.ts";

Deno.test("WRITABLE_TABLE_NAMES - is non-empty", () => {
	// An empty list would silently make every write a compile error, which
	// looks exactly like "the types are broken" from a customer's side.
	assert(WRITABLE_TABLE_NAMES.length > 0, "no customer-writable tables were generated");
});

Deno.test("WRITABLE_TABLE_NAMES - has no duplicates and is sorted", () => {
	const names = [...WRITABLE_TABLE_NAMES];
	assertEquals(new Set(names).size, names.length, "duplicate entries in the writable table list");
	assertEquals(names, [...names].sort(), "the generated list must be sorted so diffs stay readable");
});

// A previous version of this file tried to assert "the writable set did not
// degenerate into the whole schema" by counting `Object.keys({} as DB)`. That
// is always zero — `DB` is a type, not a value — and the threshold it compared
// against was larger than the entire schema, so the check could never fail.
// The literal pin at the bottom of this file is what actually guards the
// writable surface, and it is worth more than a count ever was.

Deno.test("WritableTableName - every name indexes both DB and WritableDB", () => {
	// A compile-time assertion, written as a test so it is visible: if a
	// generated name ever fell out of `DB`, neither alias below would resolve.
	type EveryNameIsInDb = WritableTableName extends keyof DB ? true : never;
	type EveryNameIsWritable = WritableTableName extends keyof WritableDB ? true : never;
	const inDb: EveryNameIsInDb = true;
	const inWritable: EveryNameIsWritable = true;
	assert(inDb && inWritable);
});

Deno.test("WRITABLE_TABLE_NAMES - matches the tables the schema marks read-write", () => {
	// Pinned as a literal so that flipping a table's flag is a deliberate,
	// reviewable change to this list rather than a silent widening of what
	// customers may write. Update this only alongside the DSL change.
	assertEquals([...WRITABLE_TABLE_NAMES], [
		"brand_config_amazon_asin",
		"brand_config_amazon_attributes",
		"brand_config_amazon_family",
		"brand_config_business_attributes",
		"brand_config_ontology_category",
		"brand_config_ontology_metadata",
		"brand_config_ontology_variant",
	]);
});
