/**
 * Unit tests for the writable-table surface.
 *
 * `WRITABLE_TABLE_NAMES` is generated from the schema DSL's per-table read/write
 * flag. Its exact membership is pinned by the drift gate in `tests/integration/`,
 * and the subset relationship to `DB` by `Pick<DB, WritableTableName>` in
 * `src/WritableDB.ts`, which `deno task check` verifies on every run. What is
 * left to pin here is what neither of those can see: the drift gate compares the
 * generator's output with itself, so a generator that emits an empty, duplicated
 * or unsorted list passes it.
 *
 * Public-safe: this file syncs to the public mirror.
 */

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { WRITABLE_TABLE_NAMES } from "../../src/WRITABLE_TABLE_NAMES.ts";

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
