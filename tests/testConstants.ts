/**
 * Shared test constants for this package's suites.
 * Use these instead of defining local test constants.
 *
 * The values are deliberately fictional. This file syncs to the public mirror
 * and the ids also appear in published documentation, so a test fixture that
 * borrowed a real workspace id would put that id in front of every customer who
 * reads the package. `123_456_789` keeps the 9-digit shape production uses
 * (workspace ids start at 100_000_001) while being obviously not a real one.
 *
 * Kept at the `tests/` root on purpose: `tests/unit/` is public-safe and syncs,
 * while `tests/integration/` and `tests/monorepo/` do not (see MONOREPO_ONLY in
 * `tools/mirrorConfig.ts`). A constants module shared by all three therefore
 * cannot live inside any of them without either breaking the mirror's suite or
 * leaking a monorepo-only directory into it.
 */

export const TESTING_wsid1 = 123_456_789;
export const TESTING_wsid2 = 123_456_790;

/**
 * Hosted workspace schema names, in the `w<wsid>` shape production uses.
 *
 * Which one is provisioned is the caller's business: a suite that needs a
 * schema that exists but was never provisioned uses the second and says so.
 */
export const TESTING_tenantSchema1 = `w${TESTING_wsid1}`;
export const TESTING_tenantSchema2 = `w${TESTING_wsid2}`;
