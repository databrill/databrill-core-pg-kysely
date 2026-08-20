/**
 * Canonical readers entry point: `@databrill/core-pg-kysely/canonical`.
 *
 * A canonical reader is a conceptual table declared once as data — its grain,
 * its group-by levels, its measures with an additivity classification, its
 * filters, and the relations it needs — from which the protocol surfaces are
 * projections: the MCP tool contract today, GraphQL fields and an OpenAPI
 * document later. The canonical modelling is the deliverable; a protocol is a
 * view of it.
 *
 * Queries, not database views, and deliberately so for now: a reader compiles a
 * Kysely query against the generated tenant schema and hands the SQL to a
 * postgres.js connection the caller already owns. Nothing here opens a
 * connection, migrates a tenant database, or creates a relation.
 *
 * This entry point depends on `kysely` and this package's own modules and
 * nothing else. In particular it does NOT pull in `pg`, so `services/` and
 * `mcp-local`, which connect with postgres.js, can import it without acquiring
 * a second driver.
 *
 * ```ts
 * import postgres from "postgres";
 * import {
 * 	AMAZON_REPORT_SALES_AND_TRAFFIC,
 * 	createCanonicalQueryBuilder,
 * 	makePostgresJsTypes,
 * 	readAmazonReportSalesAndTraffic,
 * } from "@databrill/core-pg-kysely/canonical";
 *
 * const sql = postgres(uri, { types: makePostgresJsTypes() });
 * const db = createCanonicalQueryBuilder();
 *
 * const result = await readAmazonReportSalesAndTraffic(db, sql, {
 * 	level: "ASIN",
 * 	timeGranularity: "DAY",
 * 	window: { kind: "trailingDays", days: 7 },
 * });
 * // result.window.dateLast is the source's own maxDefinitiveDate, not MAX(date).
 * ```
 *
 * @module
 */

export {
	type CanonicalQueryRunner,
	createCanonicalQueryBuilder,
	executeCompiled,
	makePostgresJsTypes,
	type PostgresJsTypeHandler,
} from "./execute.ts";

export {
	CANONICAL_AXES,
	CANONICAL_LEVELS,
	CANONICAL_TIME_GRANULARITIES,
	type CanonicalAdditivity,
	type CanonicalAxis,
	type CanonicalCaveat,
	type CanonicalDeclaration,
	type CanonicalDimensionSource,
	type CanonicalFactSource,
	type CanonicalFilter,
	type CanonicalLevel,
	type CanonicalLevelSpec,
	type CanonicalMeasure,
	type CanonicalMeasureValue,
	type CanonicalSource,
	type CanonicalTimeGranularity,
	type CanonicalUnavailability,
	caveatsForLevel,
	keyColumnsForMeasures,
	levelSpec,
	measuresForLevel,
} from "./declaration.ts";

export {
	FRESHNESS_RULE,
	ORDERS_FRESHNESS_RULE,
	type SourceFreshness,
	type StoreFreshness,
	type StoreRef,
} from "./freshness.ts";

export { probeRelations } from "./relations.ts";

export {
	type CanonicalReferenceDeclaration,
	type CanonicalReferenceField,
	type CanonicalReferenceSource,
	type CanonicalReferenceUnavailability,
} from "./referenceDeclaration.ts";

export { type CanonicalResolvedWindow, type CanonicalWindow, resolveCanonicalWindow } from "./window.ts";

export { AMAZON_ORDERS } from "./amazonOrders/declaration.ts";
export {
	type AmazonOrdersRequest,
	type AmazonOrdersResult,
	type AmazonOrdersRow,
	readAmazonOrders,
} from "./amazonOrders/read.ts";

export { AMAZON_COUNTRY } from "./AmazonCountry/declaration.ts";
export {
	type AmazonCountryRequest,
	type AmazonCountryResult,
	type AmazonCountryRow,
	readAmazonCountries,
} from "./AmazonCountry/read.ts";

export { AMAZON_MARKETPLACE } from "./AmazonMarketplace/declaration.ts";
export {
	type AmazonMarketplaceRequest,
	type AmazonMarketplaceResult,
	type AmazonMarketplaceRow,
	readAmazonMarketplaces,
} from "./AmazonMarketplace/read.ts";

export { AMAZON_REPORT_SALES_AND_TRAFFIC } from "./AmazonReport_SALES_AND_TRAFFIC/declaration.ts";
export {
	type AmazonReportSalesAndTrafficRequest,
	type AmazonReportSalesAndTrafficResult,
	type AmazonReportSalesAndTrafficRow,
	readAmazonReportSalesAndTraffic,
} from "./AmazonReport_SALES_AND_TRAFFIC/read.ts";

export { AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE } from "./AmazonReport_SEARCH_QUERY_PERFORMANCE/declaration.ts";
export {
	type AmazonReportSearchQueryPerformanceLevel,
	type AmazonReportSearchQueryPerformanceRequest,
	type AmazonReportSearchQueryPerformanceResult,
	type AmazonReportSearchQueryPerformanceRow,
	type AmazonReportSearchQueryPerformanceTimeGranularity,
	type AmazonReportSearchQueryPerformanceTimeUnit,
	readAmazonReportSearchQueryPerformance,
	SEARCH_QUERY_PERFORMANCE_TIME_UNITS,
} from "./AmazonReport_SEARCH_QUERY_PERFORMANCE/read.ts";
