import { type CompiledQuery, type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "../../types.ts";
import {
	type CanonicalCaveat,
	type CanonicalMeasure,
	type CanonicalUnavailability,
	caveatsForLevel,
	keyColumnsForMeasures,
	levelSpec,
	measuresForLevel,
} from "../declaration.ts";
import { type CanonicalQueryRunner, executeCompiled } from "../execute.ts";
import {
	readFreshness,
	searchQueryPerformanceFreshnessQuery,
	type SourceFreshness,
	type StoreRef,
} from "../freshness.ts";
import { col, rel } from "../names.ts";
import { probeRelations } from "../relations.ts";
import { type CanonicalResolvedWindow, type CanonicalWindow, resolveCanonicalWindow } from "../window.ts";
import { AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE } from "./declaration.ts";

/** Report period types Amazon publishes for Search Query Performance. */
export const SEARCH_QUERY_PERFORMANCE_TIME_UNITS = ["WEEK", "MONTH"] as const;

export type AmazonReportSearchQueryPerformanceTimeUnit = typeof SEARCH_QUERY_PERFORMANCE_TIME_UNITS[number];

/** Levels this reader offers. `SEARCH_QUERY` is independent of the product hierarchy. */
export type AmazonReportSearchQueryPerformanceLevel = "SUM" | "STORE" | "SEARCH_QUERY";

/** Keep delivered periods distinct, or aggregate them into the requested window. */
export type AmazonReportSearchQueryPerformanceTimeGranularity =
	| AmazonReportSearchQueryPerformanceTimeUnit
	| "TOTAL";

export interface AmazonReportSearchQueryPerformanceRequest {
	readonly level: AmazonReportSearchQueryPerformanceLevel;
	/** Which pre-aggregated source rows to select. */
	readonly reportTimeUnit: AmazonReportSearchQueryPerformanceTimeUnit;
	/** Must equal `reportTimeUnit`, unless it is TOTAL. SQP is never rebucketed. */
	readonly timeGranularity: AmazonReportSearchQueryPerformanceTimeGranularity;
	readonly window: CanonicalWindow;
	/** Empty or absent means every store represented in the report table. */
	readonly stores?: readonly StoreRef[];
	/** The filter stays inside market-grain normalization. */
	readonly asins?: readonly string[];
	readonly measures?: readonly string[];
	/** Valid only for SEARCH_QUERY/TOTAL, ordered by corrected total query impressions. */
	readonly limit?: number;
}

export interface AmazonReportSearchQueryPerformanceRow {
	/** Source period's dateFirst for WEEK/MONTH, or the requested window for TOTAL. */
	readonly period: string;
	readonly key: Readonly<Record<string, string>>;
	readonly measures: Readonly<Record<string, number | null>>;
}

export interface AmazonReportSearchQueryPerformanceResult {
	readonly declaration: string;
	readonly level: AmazonReportSearchQueryPerformanceLevel;
	readonly reportTimeUnit: AmazonReportSearchQueryPerformanceTimeUnit;
	readonly timeGranularity: AmazonReportSearchQueryPerformanceTimeGranularity;
	readonly window: CanonicalResolvedWindow | null;
	readonly measures: readonly CanonicalMeasure[];
	readonly freshness: SourceFreshness | null;
	readonly caveats: readonly CanonicalCaveat[];
	readonly unavailable: readonly CanonicalUnavailability[];
	readonly rows: readonly AmazonReportSearchQueryPerformanceRow[];
}

/** A selected database value before the reader separates keys and measures. */
export type SearchQueryPerformanceCellValue = string | number | null;

/** Inputs to the compiled aggregate query after declaration and freshness resolution. */
export interface SearchQueryPerformanceQueryParams {
	readonly request: AmazonReportSearchQueryPerformanceRequest;
	readonly keyColumns: readonly string[];
	readonly stores: readonly StoreRef[];
	readonly window: { readonly dateFirst: string; readonly dateLast: string };
	readonly measures: readonly CanonicalMeasure[];
}

/**
 * Read Search Query Performance through its canonical two-stage aggregation.
 *
 * Seller `asin*` counts are summed inside the normalization query. Whole-market
 * `total*` counts use MAX there because Amazon repeats them on every ASIN row.
 * Only the normalized rows reach the outer aggregation.
 */
export async function readAmazonReportSearchQueryPerformance(
	db: Kysely<DB>,
	runner: CanonicalQueryRunner,
	request: AmazonReportSearchQueryPerformanceRequest,
): Promise<AmazonReportSearchQueryPerformanceResult> {
	validateRequest(request);
	const spec = levelSpec(AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE, request.level);
	if (spec === undefined) {
		throw new Error(
			`AmazonReport_SEARCH_QUERY_PERFORMANCE does not offer the level ${request.level}. Offered: ${
				AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE.levels.map((entry) => entry.level).join(", ")
			}`,
		);
	}
	const source = AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE.sources.find((candidate) => candidate.key === spec.source);
	if (source === undefined || source.role !== "FACT") {
		throw new Error(
			`AmazonReport_SEARCH_QUERY_PERFORMANCE level ${request.level} names an undeclared source ${spec.source}`,
		);
	}

	const stores = request.stores ?? [];
	const caveats = caveatsForLevel(AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE, request.level);
	const empty = {
		declaration: AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE.name,
		level: request.level,
		reportTimeUnit: request.reportTimeUnit,
		timeGranularity: request.timeGranularity,
		caveats,
		rows: [],
	} as const;

	const present = await probeRelations(db, runner, [source.relation]);
	if (!present.has(source.relation)) {
		return {
			...empty,
			window: null,
			measures: [],
			freshness: null,
			unavailable: [{
				level: request.level,
				source: source.key,
				relation: source.relation,
				reason: source.whenAbsent,
			}],
		};
	}

	const freshness = await readFreshness(db, runner, {
		source: source.key,
		relation: source.relation,
		rule: "Latest delivered dateLast for the selected WEEK or MONTH report rows. SQP periods arrive closed, " +
			"so latest present and latest definitive are the same date.",
		query: searchQueryPerformanceFreshnessQuery(stores, request.reportTimeUnit),
	});
	if (freshness.anchorDate === null) {
		return {
			...empty,
			window: null,
			measures: [],
			freshness,
			unavailable: [{
				level: request.level,
				source: source.key,
				relation: source.relation,
				reason: `${source.whenAbsent} No ${request.reportTimeUnit} period exists for the stores in scope.`,
			}],
		};
	}

	const window = resolveCanonicalWindow(request.window, freshness.anchorDate);
	const measures = selectMeasures(request);
	const rows = await executeCompiled(
		runner,
		compileSearchQueryPerformanceQuery(db, {
			request,
			keyColumns: keyColumnsForMeasures(spec, measures),
			stores,
			window,
			measures,
		}),
	);

	return {
		...empty,
		window,
		measures,
		freshness,
		unavailable: [],
		rows: rows.map((row) => buildRow(row, spec.keyColumns, measures)),
	};
}

function validateRequest(request: AmazonReportSearchQueryPerformanceRequest): void {
	if (request.timeGranularity !== "TOTAL" && request.timeGranularity !== request.reportTimeUnit) {
		throw new Error(
			`AmazonReport_SEARCH_QUERY_PERFORMANCE cannot rebucket ${request.reportTimeUnit} rows as ` +
				`${request.timeGranularity}. Use ${request.reportTimeUnit} or TOTAL.`,
		);
	}
	if (request.limit !== undefined) {
		if (!Number.isInteger(request.limit) || request.limit <= 0) {
			throw new Error("AmazonReport_SEARCH_QUERY_PERFORMANCE limit must be a positive integer.");
		}
		if (request.level !== "SEARCH_QUERY" || request.timeGranularity !== "TOTAL") {
			throw new Error("AmazonReport_SEARCH_QUERY_PERFORMANCE limit is valid only for SEARCH_QUERY/TOTAL.");
		}
	}
}

function selectMeasures(request: AmazonReportSearchQueryPerformanceRequest): readonly CanonicalMeasure[] {
	const offered = measuresForLevel(AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE, request.level);
	const asked = request.measures;
	if (asked === undefined) {
		return offered;
	}
	const unknown = asked.filter((name) => !offered.some((measure) => measure.name === name));
	if (unknown.length > 0) {
		throw new Error(
			`AmazonReport_SEARCH_QUERY_PERFORMANCE does not offer ${unknown.join(", ")} at level ${request.level}. ` +
				`Offered: ${offered.map((measure) => measure.name).join(", ")}`,
		);
	}
	const wanted = new Set(asked);
	for (const measure of offered) {
		if (wanted.has(measure.name) && measure.additivity.kind === "RATIO") {
			wanted.add(measure.additivity.numerator);
			wanted.add(measure.additivity.denominator);
		}
	}
	return offered.filter((measure) => wanted.has(measure.name));
}

interface NamedExpression {
	readonly name: string;
	readonly expression: RawBuilder<unknown>;
}

/** Build and compile the normalized aggregate without executing it. */
export function compileSearchQueryPerformanceQuery(
	db: Kysely<DB>,
	params: SearchQueryPerformanceQueryParams,
): CompiledQuery<Record<string, SearchQueryPerformanceCellValue>> {
	validateRequest(params.request);
	const merchantId = col("amzreport_SEARCH_QUERY_PERFORMANCE", "merchantId");
	const marketplaceId = col("amzreport_SEARCH_QUERY_PERFORMANCE", "marketplaceId");
	const timeUnit = col("amzreport_SEARCH_QUERY_PERFORMANCE", "timeUnit");
	const dateFirst = col("amzreport_SEARCH_QUERY_PERFORMANCE", "dateFirst");
	const dateLast = col("amzreport_SEARCH_QUERY_PERFORMANCE", "dateLast");
	const asin = col("amzreport_SEARCH_QUERY_PERFORMANCE", "asin");
	const searchQuery = col("amzreport_SEARCH_QUERY_PERFORMANCE", "searchQuery");

	const normalizationKeys: NamedExpression[] = [];
	if (params.request.level === "STORE") {
		normalizationKeys.push({ name: "merchantId", expression: merchantId });
	}
	normalizationKeys.push(
		{ name: "marketplaceId", expression: marketplaceId },
		{ name: "dateFirst", expression: dateFirst },
		{ name: "dateLast", expression: dateLast },
		{ name: "searchQuery", expression: searchQuery },
	);

	const normalizedSelections: RawBuilder<unknown>[] = [
		...normalizationKeys.map((key) => sql`${key.expression} AS ${sql.ref(key.name)}`),
		...normalizedCountSelections(),
	];
	const storeFilter = params.stores.length === 0
		? sql``
		: sql`AND (${merchantId}, ${marketplaceId}) IN (${
			sql.join(params.stores.map((store) => sql`(${store.merchantId}, ${store.marketplaceId})`))
		})`;
	const asinFilter = params.request.asins === undefined || params.request.asins.length === 0
		? sql``
		: sql`AND ${asin} IN (${sql.join(params.request.asins.map((value) => sql`${value}`))})`;

	const periodSelection = params.request.timeGranularity === "TOTAL"
		? sql`${`${params.window.dateFirst}/${params.window.dateLast}`}::text AS "period"`
		: sql`${sql.ref("n.dateFirst")}::text AS "period"`;
	const outputSelections: RawBuilder<unknown>[] = [
		periodSelection,
		...params.keyColumns.map((column) => sql`${sql.ref(`n.${column}`)} AS ${sql.ref(column)}`),
		...params.measures
			.filter((measure) => measure.additivity.kind !== "RATIO")
			.map((measure) => sql`SUM(${sql.ref(`n.${measure.name}`)})::numeric AS ${sql.ref(measure.name)}`),
	];

	const outputGrouping: RawBuilder<unknown>[] = [];
	if (params.request.timeGranularity !== "TOTAL") {
		outputGrouping.push(sql.ref("n.dateFirst"), sql.ref("n.dateLast"));
	}
	outputGrouping.push(...params.keyColumns.map((column) => sql.ref(`n.${column}`)));
	const groupBy = outputGrouping.length === 0 ? sql`` : sql`GROUP BY ${sql.join(outputGrouping)}`;
	const orderBy = outputOrderBy(params);
	const limit = params.request.limit === undefined ? sql`` : sql`LIMIT ${params.request.limit}`;

	return sql<Record<string, SearchQueryPerformanceCellValue>>`
		WITH normalized AS (
			SELECT ${sql.join(normalizedSelections)}
			FROM ${rel("amzreport_SEARCH_QUERY_PERFORMANCE")}
			WHERE ${timeUnit} = ${params.request.reportTimeUnit}
			  AND ${dateFirst} >= ${params.window.dateFirst}::date
			  AND ${dateLast} <= ${params.window.dateLast}::date
			${storeFilter}
			${asinFilter}
			GROUP BY ${sql.join(normalizationKeys.map((key) => key.expression))}
		)
		SELECT ${sql.join(outputSelections)}
		FROM normalized n
		${groupBy}
		${orderBy}
		${limit}
	`.compile(db);
}

function normalizedCountSelections(): readonly RawBuilder<unknown>[] {
	return [
		sql`SUM((${col("amzreport_SEARCH_QUERY_PERFORMANCE", "impressionData")}->>'asinImpressionCount')::numeric) AS ${
			sql.ref("asinImpressionCount")
		}`,
		sql`MAX((${
			col("amzreport_SEARCH_QUERY_PERFORMANCE", "impressionData")
		}->>'totalQueryImpressionCount')::numeric) AS ${sql.ref("totalQueryImpressionCount")}`,
		sql`SUM((${col("amzreport_SEARCH_QUERY_PERFORMANCE", "clickData")}->>'asinClickCount')::numeric) AS ${
			sql.ref("asinClickCount")
		}`,
		sql`MAX((${col("amzreport_SEARCH_QUERY_PERFORMANCE", "clickData")}->>'totalClickCount')::numeric) AS ${
			sql.ref("totalClickCount")
		}`,
		sql`SUM((${col("amzreport_SEARCH_QUERY_PERFORMANCE", "purchaseData")}->>'asinPurchaseCount')::numeric) AS ${
			sql.ref("asinPurchaseCount")
		}`,
		sql`MAX((${col("amzreport_SEARCH_QUERY_PERFORMANCE", "purchaseData")}->>'totalPurchaseCount')::numeric) AS ${
			sql.ref("totalPurchaseCount")
		}`,
	];
}

function outputOrderBy(params: SearchQueryPerformanceQueryParams): RawBuilder<unknown> {
	const expressions: RawBuilder<unknown>[] = [];
	if (params.request.timeGranularity !== "TOTAL") {
		expressions.push(sql`${sql.ref("n.dateFirst")} ASC`, sql`${sql.ref("n.dateLast")} ASC`);
	}
	if (params.request.level === "SEARCH_QUERY") {
		expressions.push(sql`SUM(${sql.ref("n.totalQueryImpressionCount")}) DESC NULLS LAST`);
	}
	for (const column of params.keyColumns) {
		expressions.push(sql`${sql.ref(`n.${column}`)} ASC`);
	}
	return expressions.length === 0 ? sql`` : sql`ORDER BY ${sql.join(expressions)}`;
}

function buildRow(
	row: Readonly<Record<string, SearchQueryPerformanceCellValue>>,
	keyColumns: readonly string[],
	measures: readonly CanonicalMeasure[],
): AmazonReportSearchQueryPerformanceRow {
	const key: Record<string, string> = {};
	for (const column of keyColumns) {
		const value = row[column];
		key[column] = value === null || value === undefined ? "" : String(value);
	}

	const values: Record<string, number | null> = {};
	for (const measure of measures) {
		if (measure.additivity.kind === "RATIO") {
			continue;
		}
		const value = row[measure.name];
		values[measure.name] = value === null || value === undefined
			? null
			: typeof value === "number"
			? value
			: Number(value);
	}
	for (const measure of measures) {
		if (measure.additivity.kind !== "RATIO") {
			continue;
		}
		const numerator = values[measure.additivity.numerator];
		const denominator = values[measure.additivity.denominator];
		values[measure.name] = typeof numerator !== "number" || typeof denominator !== "number" || denominator === 0
			? null
			: (numerator / denominator) * measure.additivity.scale;
	}

	const period = row["period"];
	return { period: period === null || period === undefined ? "" : String(period), key, measures: values };
}
