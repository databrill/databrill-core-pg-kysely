import { type CompiledQuery, type Expression, type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "../../types.ts";
import { type CanonicalQueryRunner, executeCompiled } from "../execute.ts";
import { probeRelations } from "../relations.ts";
import type { CanonicalReferenceUnavailability } from "../referenceDeclaration.ts";
import { AMAZON_COUNTRY } from "./declaration.ts";

export interface AmazonCountryRequest {
	readonly countryCodes?: readonly string[];
	readonly regions?: readonly string[];
}

export interface AmazonCountryRow {
	readonly countryCode: string;
	readonly countryName: string;
	readonly region: string;
	readonly timeZone: string;
}

export interface AmazonCountryResult {
	readonly declaration: string;
	readonly unavailable: readonly CanonicalReferenceUnavailability[];
	readonly rows: readonly AmazonCountryRow[];
}

/** Read Amazon country reference rows. */
export async function readAmazonCountries(
	db: Kysely<DB>,
	runner: CanonicalQueryRunner,
	request: AmazonCountryRequest = {},
): Promise<AmazonCountryResult> {
	const present = await probeRelations(db, runner, [AMAZON_COUNTRY.source.relation]);
	if (!present.has(AMAZON_COUNTRY.source.relation)) {
		return {
			declaration: AMAZON_COUNTRY.name,
			rows: [],
			unavailable: [{ relation: AMAZON_COUNTRY.source.relation, reason: AMAZON_COUNTRY.source.whenAbsent }],
		};
	}
	const rows = Array.from(await executeCompiled(runner, compileAmazonCountryQuery(db, request)));
	return { declaration: AMAZON_COUNTRY.name, unavailable: [], rows };
}

/** Compile the country lookup without executing it. */
export function compileAmazonCountryQuery(
	db: Kysely<DB>,
	request: AmazonCountryRequest = {},
): CompiledQuery<AmazonCountryRow> {
	return db
		.selectFrom("amazon_country")
		.select([
			"country_code as countryCode",
			"country_name as countryName",
			"region",
			"time_zone as timeZone",
		])
		.$if(
			(request.countryCodes ?? []).length > 0,
			(qb) => qb.where(inList(sql.ref("country_code"), request.countryCodes ?? [])),
		)
		.$if((request.regions ?? []).length > 0, (qb) => qb.where(inList(sql.ref("region"), request.regions ?? [])))
		.orderBy("country_code")
		.compile();
}

function inList(expression: RawBuilder<unknown>, values: readonly string[]): Expression<boolean> {
	return sql<boolean>`${expression} IN (${sql.join(values.map((value) => sql`${value}`))})`;
}
