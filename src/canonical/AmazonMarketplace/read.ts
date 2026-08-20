import { type CompiledQuery, type Expression, type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "../../types.ts";
import { type CanonicalQueryRunner, executeCompiled } from "../execute.ts";
import { probeRelations } from "../relations.ts";
import type { CanonicalReferenceUnavailability } from "../referenceDeclaration.ts";
import { AMAZON_MARKETPLACE } from "./declaration.ts";

export interface AmazonMarketplaceRequest {
	readonly marketplaceIds?: readonly string[];
	readonly marketplaceCodes?: readonly string[];
	readonly countryCodes?: readonly string[];
}

export interface AmazonMarketplaceRow {
	readonly marketplaceId: string;
	readonly marketplaceCode: string;
	readonly name: string;
	readonly countryCode: string;
	readonly currency: string;
	readonly languageCode: string;
	readonly domain: string;
	readonly timeZone: string | null;
}

export interface AmazonMarketplaceResult {
	readonly declaration: string;
	readonly unavailable: readonly CanonicalReferenceUnavailability[];
	readonly rows: readonly AmazonMarketplaceRow[];
}

/** Read Amazon marketplace reference rows. */
export async function readAmazonMarketplaces(
	db: Kysely<DB>,
	runner: CanonicalQueryRunner,
	request: AmazonMarketplaceRequest = {},
): Promise<AmazonMarketplaceResult> {
	const present = await probeRelations(db, runner, [AMAZON_MARKETPLACE.source.relation]);
	if (!present.has(AMAZON_MARKETPLACE.source.relation)) {
		return {
			declaration: AMAZON_MARKETPLACE.name,
			rows: [],
			unavailable: [{
				relation: AMAZON_MARKETPLACE.source.relation,
				reason: AMAZON_MARKETPLACE.source.whenAbsent,
			}],
		};
	}
	const rows = Array.from(await executeCompiled(runner, compileAmazonMarketplaceQuery(db, request)));
	return { declaration: AMAZON_MARKETPLACE.name, unavailable: [], rows };
}

/** Compile the marketplace lookup without executing it. */
export function compileAmazonMarketplaceQuery(
	db: Kysely<DB>,
	request: AmazonMarketplaceRequest = {},
): CompiledQuery<AmazonMarketplaceRow> {
	return db
		.selectFrom("amazon_marketplace")
		.select([
			"marketplace_id as marketplaceId",
			"marketplace_code as marketplaceCode",
			"name",
			"country_code as countryCode",
			"currency",
			"lang as languageCode",
			"domain",
			"time_zone as timeZone",
		])
		.$if(
			(request.marketplaceIds ?? []).length > 0,
			(qb) => qb.where(inList(sql.ref("marketplace_id"), request.marketplaceIds ?? [])),
		)
		.$if(
			(request.marketplaceCodes ?? []).length > 0,
			(qb) => qb.where(inList(sql.ref("marketplace_code"), request.marketplaceCodes ?? [])),
		)
		.$if(
			(request.countryCodes ?? []).length > 0,
			(qb) => qb.where(inList(sql.ref("country_code"), request.countryCodes ?? [])),
		)
		.orderBy("marketplace_id")
		.compile();
}

function inList(expression: RawBuilder<unknown>, values: readonly string[]): Expression<boolean> {
	return sql<boolean>`${expression} IN (${sql.join(values.map((value) => sql`${value}`))})`;
}
