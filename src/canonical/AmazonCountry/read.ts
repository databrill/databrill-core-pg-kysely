import { Effect, Either } from "effect";
import { type CompiledQuery, type Kysely } from "kysely";
import { tryOrOperationError } from "../../tryOrOperationError.ts";
import type { DB } from "../../types.ts";
import { type CanonicalQueryRunner, executeCompiled } from "../execute.ts";
import type { CanonicalReferenceUnavailability } from "../referenceDeclaration.ts";
import { probeRelations } from "../relations.ts";
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
export function readAmazonCountries(
	db: Kysely<DB>,
	runner: CanonicalQueryRunner,
	request: AmazonCountryRequest = {},
): Effect.Effect<AmazonCountryResult, Error> {
	return Effect.gen(function* () {
		const present = yield* probeRelations(db, runner, [AMAZON_COUNTRY.source.relation]);
		if (!present.has(AMAZON_COUNTRY.source.relation)) {
			return {
				declaration: AMAZON_COUNTRY.name,
				rows: [],
				unavailable: [{ relation: AMAZON_COUNTRY.source.relation, reason: AMAZON_COUNTRY.source.whenAbsent }],
			};
		}
		const rows = Array.from(yield* executeCompiled(runner, yield* compileAmazonCountryQuery(db, request)));
		return { declaration: AMAZON_COUNTRY.name, unavailable: [], rows };
	});
}

/** Compile the country lookup without executing it. */
export function compileAmazonCountryQuery(
	db: Kysely<DB>,
	request: AmazonCountryRequest = {},
): Either.Either<CompiledQuery<AmazonCountryRow>, Error> {
	return tryOrOperationError(() => {
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
				(qb) => qb.where("country_code", "in", request.countryCodes ?? []),
			)
			.$if(
				(request.regions ?? []).length > 0,
				(qb) => qb.where("region", "in", request.regions ?? []),
			)
			.orderBy("country_code")
			.compile();
	});
}
