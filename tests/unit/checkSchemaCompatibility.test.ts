/**
 * Unit tests for the schema-compatibility comparison.
 *
 * `compareSchemaVersions` is the whole decision; `checkSchemaCompatibility` only
 * fetches a row and hands it over. The behaviour worth pinning is that minor
 * skew WARNS instead of throwing (a hard failure would turn every fleet rollout
 * into a customer outage) and that the `0.x` component shift is applied — while
 * the package is pre-1.0 the breaking component is the minor slot, and reading
 * `major` literally would report every breaking change as compatible.
 *
 * Public-safe: this file syncs to the public mirror.
 */

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { compareSchemaVersions } from "../../src/checkSchemaCompatibility.ts";
import { SCHEMA_VERSION } from "../../src/schemaVersion.ts";

Deno.test("compareSchemaVersions - identical versions are ok", () => {
	const result = compareSchemaVersions("0.1.0", "0.1.0");
	assertEquals(result.level, "ok");
	assertEquals(result.packageVersion, "0.1.0");
	assertEquals(result.databaseVersion, "0.1.0");
});

Deno.test("compareSchemaVersions - while 0.x, the minor slot is what breaks", () => {
	// 0.1.0 vs 0.2.0 is a breaking difference under the 0.x convention, even
	// though both have major 0.
	const result = compareSchemaVersions("0.1.0", "0.2.0");
	assertEquals(result.level, "error");
	assert(result.message.includes("0.2.0"), "the message must name the database version to install against");
});

Deno.test("compareSchemaVersions - while 0.x, the patch slot is what adds", () => {
	assertEquals(compareSchemaVersions("0.1.0", "0.1.3").level, "warning");
	assertEquals(compareSchemaVersions("0.1.3", "0.1.0").level, "warning");
});

Deno.test("compareSchemaVersions - the warning says which side is ahead", () => {
	const behind = compareSchemaVersions("0.1.0", "0.1.3");
	assert(behind.message.includes("upgrade"), `package behind should suggest upgrading: ${behind.message}`);

	const ahead = compareSchemaVersions("0.1.3", "0.1.0");
	assert(
		ahead.message.includes("may not exist yet"),
		`package ahead should warn about missing tables: ${ahead.message}`,
	);
});

Deno.test("compareSchemaVersions - past 1.0, the major slot is what breaks", () => {
	assertEquals(compareSchemaVersions("1.4.0", "2.0.0").level, "error");
	assertEquals(compareSchemaVersions("1.4.0", "1.7.0").level, "warning");
	assertEquals(compareSchemaVersions("1.4.0", "1.4.9").level, "ok");
});

Deno.test("compareSchemaVersions - crossing 0.x to 1.x is breaking", () => {
	// The 0.x component shift moves the roles down one slot, so a naive
	// implementation ranks 0.1.0 and 1.0.0 identically (breaking=1, additive=0)
	// and calls them compatible. These are the exact collisions that hid the bug:
	// `0.9.0` vs `1.0.0` passes even when broken, because 9 != 1.
	assertEquals(compareSchemaVersions("0.1.0", "1.0.0").level, "error");
	assertEquals(compareSchemaVersions("0.2.0", "2.0.0").level, "error");
	assertEquals(compareSchemaVersions("0.2.0", "2.5.0").level, "error");
	assertEquals(compareSchemaVersions("1.0.0", "0.1.0").level, "error");
	assertEquals(compareSchemaVersions("0.9.0", "1.0.0").level, "error");
});

Deno.test("compareSchemaVersions - a database with no recorded version is unknown, not ok", () => {
	const result = compareSchemaVersions("0.1.0", null);
	assertEquals(result.level, "unknown");
	assertEquals(result.databaseVersion, null);
});

Deno.test("compareSchemaVersions - an unparseable version is unknown, not an error", () => {
	// Reporting `error` here would tell a customer their database is
	// incompatible on the strength of a string this package failed to read.
	assertEquals(compareSchemaVersions("0.1.0", "not-a-version").level, "unknown");
	assertEquals(compareSchemaVersions("garbage", "0.1.0").level, "unknown");
});

Deno.test("compareSchemaVersions - prerelease and build suffixes compare on their numeric core", () => {
	assertEquals(compareSchemaVersions("0.1.0", "0.1.0-rc.1").level, "ok");
});

Deno.test("compareSchemaVersions - an ok result does not claim equality when the strings differ", () => {
	// The message is documented as fit to paste verbatim out of a customer's
	// log. `1.4.0` and `1.4.9` are compatible but not the same, and saying
	// "matches" sends whoever reads it away from a real version gap.
	const same = compareSchemaVersions("1.4.0", "1.4.0");
	assertEquals(same.level, "ok");
	assert(same.message.includes("matches"), same.message);

	const compatible = compareSchemaVersions("1.4.0", "1.4.9");
	assertEquals(compatible.level, "ok");
	assert(!compatible.message.includes("matches"), `must not claim a match: ${compatible.message}`);
	assert(compatible.message.includes("1.4.9") && compatible.message.includes("1.4.0"), compatible.message);
});

Deno.test("compareSchemaVersions - every result carries a non-empty message", () => {
	const cases: readonly (readonly [string, string | null])[] = [
		["0.1.0", "0.1.0"],
		["0.1.0", "0.2.0"],
		["0.1.0", "0.1.3"],
		["0.1.0", null],
		["0.1.0", "nonsense"],
	];
	for (const [ours, theirs] of cases) {
		const result = compareSchemaVersions(ours, theirs);
		assert(result.message.length > 0, `empty message for ${ours} vs ${String(theirs)}`);
		assertEquals(result.packageVersion, ours);
	}
});

Deno.test("SCHEMA_VERSION - the generated constant is a three-part version", () => {
	// The generator refuses to run unless this equals the package manifest's
	// version, so a malformed value here means the generated file was edited.
	assert(/^\d+\.\d+\.\d+/.test(SCHEMA_VERSION), `SCHEMA_VERSION is not a version: ${SCHEMA_VERSION}`);
	assertEquals(compareSchemaVersions(SCHEMA_VERSION, SCHEMA_VERSION).level, "ok");
});
