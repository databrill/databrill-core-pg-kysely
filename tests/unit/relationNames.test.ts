/**
 * Unit tests for the published relation-name surface.
 *
 * `TABLE_NAMES` and `VIEW_NAMES` are generated from `REMOTE_TABLES` and
 * `REMOTE_VIEWS` through the same filter that decides what reaches `db.ts`, so
 * the exact membership is pinned by the drift check in `tests/integration/` and
 * by the Docker-less companion in `services/tests/unit/`. What is worth pinning
 * here — in the package that publishes the file — is what neither of those can
 * see. The drift check compares the generator's output with itself, so a
 * generator that emits an empty, duplicated or unsorted list passes it; and the
 * two lists together being exactly `keyof DB` is a type-level claim about the
 * published surface. (That a writable table is a published table follows from
 * `Pick<DB, WritableTableName>` in `src/WritableDB.ts` plus that last check, and
 * a table and a view cannot share a name in one Postgres schema, so neither is
 * asserted here.)
 *
 * Public-safe: this file syncs to the public mirror.
 */

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import type { DB } from "../../src/db.ts";
import { TABLE_NAMES, VIEW_NAMES } from "../../src/relationNames.ts";

Deno.test("relationNames - both lists are non-empty", () => {
	// An empty list is a real generator failure mode, not a hypothetical:
	// `REMOTE_VIEWS` names its field `viewName` rather than `tableName`, so a
	// view branch written by copying the table branch emits nothing at all. To
	// a customer an empty export reads as "this export is useless" rather than
	// as a bug, so nobody reports it.
	assert(TABLE_NAMES.length > 0, "no published tenant tables were generated");
	assert(VIEW_NAMES.length > 0, "no published tenant views were generated");
});

Deno.test("relationNames - neither list has duplicates and both are sorted", () => {
	// The failure message has to name WHICH list is wrong: the two come from
	// different `REMOTE_*` arrays, so a fault in one says nothing about the
	// other. The pairs are annotated as `readonly string[]` rather than left to
	// inference, because inference from the `as const` constants gives each
	// entry a 135- or 13-element tuple type and the sorted comparison is then a
	// type error instead of a runtime check. Each list is spread before sorting
	// because the constants are `readonly` and `.sort()` mutates in place.
	const lists: readonly (readonly [string, readonly string[]])[] = [
		["TABLE_NAMES", TABLE_NAMES],
		["VIEW_NAMES", VIEW_NAMES],
	];
	for (const [label, list] of lists) {
		const names = [...list];
		assertEquals(new Set(names).size, names.length, `duplicate entries in ${label}`);
		assertEquals(names, [...names].sort(), `${label} must be sorted so diffs stay readable`);
	}
});

Deno.test("relationNames - the two lists together are exactly keyof DB", () => {
	// A compile-time assertion, written as a test so it is visible. Both
	// directions matter: `Exclude<Published, keyof DB>` catches a name the
	// lists invent, and `Exclude<keyof DB, Published>` catches a relation they
	// forget — a one-directional `extends` check would pass happily on a file
	// that had lost half the schema. The `[T] extends [never]` tuple wrapping
	// keeps the comparison non-distributive, so how a conditional resolves over
	// `never` is not something a later reader has to re-derive.
	type Published = (typeof TABLE_NAMES)[number] | (typeof VIEW_NAMES)[number];
	type ExtraNames = Exclude<Published, keyof DB>;
	type MissingNames = Exclude<keyof DB, Published>;
	const noExtras: [ExtraNames] extends [never] ? true : never = true;
	const noMissing: [MissingNames] extends [never] ? true : never = true;
	assert(noExtras && noMissing);
});
