import type { ReadonlyKysely } from "kysely/readonly";
import type { DB } from "./db.ts";
import { SCHEMA_VERSION } from "./schemaVersion.ts";

/**
 * How badly the database's schema contract and this package disagree.
 *
 * - `ok` — same contract, or a difference that cannot affect you.
 * - `warning` — additive difference. Everything you already query still works;
 *   one side simply knows about tables or columns the other does not.
 * - `error` — breaking difference. Queries this package's types permit may fail
 *   at runtime, or silently read the wrong thing.
 * - `unknown` — the database does not record a version, or it could not be
 *   read. Not an assertion of anything, in either direction.
 */
export type SchemaCompatibilityLevel = "ok" | "warning" | "error" | "unknown";

export interface SchemaCompatibility {
	readonly level: SchemaCompatibilityLevel;
	/** The contract this installed package was generated against. */
	readonly packageVersion: string;
	/** The contract the database reports, or `null` when it reports none. */
	readonly databaseVersion: string | null;
	/** A sentence suitable for logging verbatim. */
	readonly message: string;
}

/** The `component` key of the row the vendor's migration path stamps. */
const SCHEMA_VERSION_COMPONENT = "tenant-schema";

/**
 * Compare this package's schema contract against the connected database's.
 *
 * Never throws and never applies DDL: a missing table, a missing row, or a
 * permission error all resolve to `unknown`. A connectivity check is the
 * caller's job — failing their startup because a compatibility probe could not
 * read one row would be a worse outcome than not knowing.
 *
 * ```ts
 * const result = await checkSchemaCompatibility(db);
 * if (result.level === "error") {
 * 	throw new Error(result.message);
 * }
 * if (result.level !== "ok") {
 * 	console.warn(result.message);
 * }
 * ```
 */
export async function checkSchemaCompatibility(db: ReadonlyKysely<DB>): Promise<SchemaCompatibility> {
	let databaseVersion: string | null = null;
	try {
		const row = await db
			.selectFrom("databrill_schema_version")
			.select("version")
			.where("component", "=", SCHEMA_VERSION_COMPONENT)
			.executeTakeFirst();
		databaseVersion = row?.version ?? null;
	} catch (cause) {
		return {
			level: "unknown",
			packageVersion: SCHEMA_VERSION,
			databaseVersion: null,
			message: `Could not read the tenant schema version from the database (${describe(cause)}). ` +
				`This package targets ${SCHEMA_VERSION}; compatibility is unverified.`,
		};
	}
	return compareSchemaVersions(SCHEMA_VERSION, databaseVersion);
}

/**
 * The comparison, separated from the query so it can be exercised directly.
 *
 * Minor skew WARNS rather than throwing on purpose. Tenant databases are
 * migrated fleet-wide before a matching package is published, so there is
 * always a window in which a customer's database is one additive step ahead of
 * their installed package. Throwing would turn every routine rollout into a
 * customer-visible outage for work that cannot break them.
 */
export function compareSchemaVersions(packageVersion: string, databaseVersion: string | null): SchemaCompatibility {
	if (databaseVersion === null) {
		return {
			level: "unknown",
			packageVersion,
			databaseVersion: null,
			message: `The database records no tenant schema version. This package targets ${packageVersion}; ` +
				`compatibility is unverified.`,
		};
	}

	const ours = parseVersion(packageVersion);
	const theirs = parseVersion(databaseVersion);
	if (ours === null || theirs === null) {
		return {
			level: "unknown",
			packageVersion,
			databaseVersion,
			message: `Cannot compare schema versions: package ${packageVersion}, database ${databaseVersion}. ` +
				`One of them is not a three-part version.`,
		};
	}

	const ourRank = rank(ours);
	const theirRank = rank(theirs);

	// Crossing 1.0 is breaking by definition, and the shift below would hide it:
	// `rank` moves the 0.x roles down one slot, so 0.1.0 and 1.0.0 both rank as
	// breaking=1, additive=0 and would compare equal. Decide this before ranking.
	if ((ours.major === 0) !== (theirs.major === 0)) {
		return {
			level: "error",
			packageVersion,
			databaseVersion,
			message: `Incompatible tenant schema: this package targets ${packageVersion} but the database is ` +
				`${databaseVersion}, which is across the 1.0 boundary. Install the ` +
				`@databrill/core-pg-kysely release matching ${databaseVersion}.`,
		};
	}

	if (ourRank.breaking !== theirRank.breaking) {
		return {
			level: "error",
			packageVersion,
			databaseVersion,
			message: `Incompatible tenant schema: this package targets ${packageVersion} but the database is ` +
				`${databaseVersion}. Tables or columns you can write queries against may not exist, or may ` +
				`have changed meaning. Install the @databrill/core-pg-kysely release matching ${databaseVersion}.`,
		};
	}

	if (ourRank.additive !== theirRank.additive) {
		const behind = ourRank.additive < theirRank.additive;
		return {
			level: "warning",
			packageVersion,
			databaseVersion,
			message: behind
				? `The database schema ${databaseVersion} is newer than this package's ${packageVersion}. ` +
					`Your existing queries are unaffected; upgrade @databrill/core-pg-kysely to see what was added.`
				: `This package targets ${packageVersion} but the database is ${databaseVersion}. ` +
					`Some tables or columns in these types may not exist yet in your database.`,
		};
	}

	// Deliberately not "matches": once the breaking and additive slots agree,
	// any remaining difference is immaterial to compatibility but the strings
	// can still differ (`1.4.0` vs `1.4.9`). This message exists to be pasted
	// verbatim out of a customer's log, so claiming equality would send someone
	// reading it away from a real version gap.
	return {
		level: "ok",
		packageVersion,
		databaseVersion,
		message: databaseVersion === packageVersion
			? `Tenant schema ${databaseVersion} matches this package.`
			: `Tenant schema ${databaseVersion} is compatible with this package's ${packageVersion}; ` +
				`the difference does not affect any query.`,
	};
}

interface Version {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
}

/**
 * Which component carries breaking changes, and which carries additive ones.
 *
 * While the package is `0.x` — which it is until the views-as-contract question
 * is settled — the major slot is pinned at zero and the roles shift down one:
 * `0.MINOR` is what breaks and `0.x.PATCH` is what adds. That is the ordinary
 * `0.x` convention (it is what a caret range means for a zero-major package),
 * and reading `major` literally here would report every breaking change as
 * compatible for as long as this package stays pre-1.0.
 */
function rank(version: Version): { readonly breaking: number; readonly additive: number } {
	if (version.major === 0) {
		return { breaking: version.minor, additive: version.patch };
	}
	return { breaking: version.major, additive: version.minor };
}

/**
 * Parse the numeric core of a version.
 *
 * Deliberately tolerant of a suffix: `0.1.0-rc.1` and `0.1.0+build.7` compare
 * as `0.1.0`, because a prerelease of a contract describes the same contract.
 * The consequence is that a malformed four-part string like `0.1.0.5` also
 * parses as `0.1.0` rather than being rejected — acceptable, since nothing in
 * this system produces one and the alternative is calling a real version
 * unreadable.
 */
function parseVersion(value: string): Version | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
	if (match === null) {
		return null;
	}
	const [, major, minor, patch] = match;
	return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
