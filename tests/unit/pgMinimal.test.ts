/**
 * Unit test for the hand-written `pg` declarations in `src/pgMinimal.d.ts`.
 *
 * Those declarations exist so that no `npm:@types/pg` specifier survives under
 * `src/` — JSR scans the published source and turns every registry specifier it
 * finds, `@ts-types` directives included, into a `dependencies` entry. The cost
 * of writing them by hand is that nothing upstream keeps them in shape, so this
 * pins the two shapes a `pg.Pool` is actually USED as inside this package:
 * Kysely's `PostgresPool`, which `PostgresDialect` demands, and this package's
 * own `TenantPool`, which `createDb()` hands out. Drop a member from either and
 * the failure lands here, at `deno task check`, naming the file that has to
 * change.
 *
 * These are compile-time assertions with a runtime shell, deliberately: an
 * assignability failure IS the test failing, and `assert` at the bottom only
 * gives it somewhere to live.
 *
 * What this cannot check is the other direction — whether the declarations still
 * match the runtime `pg`. Nothing static can. `tests/integration/` connects for
 * real, and that is what covers it.
 *
 * Public-safe: this file syncs to the public mirror.
 */

import { assert } from "jsr:@std/assert@1.0.19";
import type { PostgresPool } from "kysely";
import type { Pool } from "../../src/pgMinimal.d.ts";
import type { TenantPool } from "../../src/createDb.ts";

/** `true` when `From` is assignable to `To`, and `never` — an error at the use site — when it is not. */
type AssignableTo<From, To> = From extends To ? true : never;

Deno.test("pgMinimal - the declared Pool satisfies both shapes this package uses it as", () => {
	const forKyselysDialect: AssignableTo<Pool, PostgresPool> = true;
	const forThePublishedTenantPool: AssignableTo<Pool, TenantPool> = true;
	assert(forKyselysDialect && forThePublishedTenantPool);
});
