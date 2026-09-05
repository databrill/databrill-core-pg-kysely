import { type AliasedRawBuilder, type CompiledQuery, type Expression, type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "../../types.ts";
import { type CanonicalQueryRunner, executeCompiled } from "../execute.ts";
import {
	type CanonicalCaveat,
	type CanonicalLevel,
	type CanonicalMeasure,
	type CanonicalTimeGranularity,
	type CanonicalUnavailability,
	caveatsForLevel,
	keyColumnsForMeasures,
	levelSpec,
	measuresForLevel,
} from "../declaration.ts";
import {
	readFreshness,
	skuByDayFreshnessQuery,
	type SourceFreshness,
	storeFreshnessQuery,
	type StoreRef,
} from "../freshness.ts";
import { probeRelations } from "../relations.ts";
import { type CanonicalResolvedWindow, type CanonicalWindow, resolveCanonicalWindow } from "../window.ts";
import { AMAZON_REPORT_SALES_AND_TRAFFIC } from "./declaration.ts";

/**
 * The `AmazonReport_SALES_AND_TRAFFIC` reader: one declaration, eight group-by levels, two
 * source relations, and the rules that keep the two apart.
 *
 * Three things here are the whole point of this reader and are easy to
 * accidentally undo:
 *
 * 1. EVERY LEVEL AGGREGATES FROM THE SOURCE GRAIN. There is no roll-up chain.
 *    `PARENT_ASIN` is marketplace-split while `ASIN` directly beneath it is not,
 *    and one ASIN sits under different parents in different marketplaces, so
 *    producing `PARENT_ASIN` by re-aggregating `ASIN` rows gives wrong answers
 *    for most of a real catalogue.
 * 2. THE STORE LEVELS READ A DIFFERENT RELATION. Sessions do not add over
 *    products, so the storefront total is read from Amazon's own storefront-wide
 *    report rather than summed up from SKUs. The two families therefore do not
 *    reconcile, which the declaration states rather than smoothing over.
 * 3. THE WINDOW ANCHORS ON THIS READER'S OWN SOURCE. A trailing window ends at
 *    the source's `maxDefinitiveDate`, never at a shared clock and never at
 *    another table's `MAX(date)`.
 */

export type { StoreRef };

export interface AmazonReportSalesAndTrafficRequest {
	readonly level: CanonicalLevel;
	readonly timeGranularity: CanonicalTimeGranularity;
	readonly window: CanonicalWindow;
	/** Empty or absent means every real store on the database. */
	readonly stores?: readonly StoreRef[];
	readonly countryCodes?: readonly string[];
	/** Child ASINs. Has no effect at the store levels, which carry no product dimension. */
	readonly asins?: readonly string[];
	/** Family names. Has no effect at the store levels. */
	readonly families?: readonly string[];
	/**
	 * Measure names to return. Absent means every measure the declaration offers
	 * at this level and time granularity.
	 */
	readonly measures?: readonly string[];
}

export interface AmazonReportSalesAndTrafficRow {
	/** The time bucket label: the date (DAY), the period's last date (WEEK/MONTH), or the window (TOTAL). */
	readonly period: string;
	/** The level's stable key columns, plus currency when a money measure is selected. */
	readonly key: Readonly<Record<string, string>>;
	readonly measures: Readonly<Record<string, number | null>>;
}

export interface AmazonReportSalesAndTrafficResult {
	readonly declaration: string;
	readonly level: CanonicalLevel;
	readonly timeGranularity: CanonicalTimeGranularity;
	readonly window: CanonicalResolvedWindow | null;
	/** Which measures the answer carries, with their additivity, so a consumer need not re-read the declaration. */
	readonly measures: readonly CanonicalMeasure[];
	readonly freshness: SourceFreshness | null;
	readonly caveats: readonly CanonicalCaveat[];
	readonly unavailable: readonly CanonicalUnavailability[];
	readonly rows: readonly AmazonReportSalesAndTrafficRow[];
}

/** The family bucket an ASIN with no configured family falls into. */
const UNMAPPED_FAMILY = "(unmapped)";

/**
 * Read `AmazonReport_SALES_AND_TRAFFIC` at one level.
 *
 * `db` is the compile-only Kysely instance from `createCanonicalQueryBuilder()`;
 * `runner` is the caller's postgres.js connection, already pinned to the
 * workspace schema and configured with `makePostgresJsTypes()`.
 */
export async function readAmazonReportSalesAndTraffic(
	db: Kysely<DB>,
	runner: CanonicalQueryRunner,
	request: AmazonReportSalesAndTrafficRequest,
): Promise<AmazonReportSalesAndTrafficResult> {
	const spec = levelSpec(AMAZON_REPORT_SALES_AND_TRAFFIC, request.level);
	if (spec === undefined) {
		throw new Error(
			`AmazonReport_SALES_AND_TRAFFIC does not offer the level ${request.level}. Offered: ${
				AMAZON_REPORT_SALES_AND_TRAFFIC.levels.map((entry) => entry.level).join(", ")
			}`,
		);
	}
	const source = AMAZON_REPORT_SALES_AND_TRAFFIC.sources.find((candidate) => candidate.key === spec.source);
	if (source === undefined || source.role !== "FACT") {
		throw new Error(
			`AmazonReport_SALES_AND_TRAFFIC level ${request.level} names an undeclared source ${spec.source}`,
		);
	}
	if (source.sourceGrainLevel === undefined) {
		throw new Error(
			`AmazonReport_SALES_AND_TRAFFIC fact source ${source.key} does not declare its source-grain level`,
		);
	}

	const stores = request.stores ?? [];
	const caveats = caveatsForLevel(AMAZON_REPORT_SALES_AND_TRAFFIC, request.level);
	const empty = {
		declaration: AMAZON_REPORT_SALES_AND_TRAFFIC.name,
		level: request.level,
		timeGranularity: request.timeGranularity,
		caveats,
		rows: [],
	} as const;

	// Relations first: a missing one is an answer, not an exception.
	const needed = AMAZON_REPORT_SALES_AND_TRAFFIC.sources
		.filter((candidate) =>
			candidate.requiredByLevels.includes(request.level) ||
			(candidate.key === "familyOntology" && (request.families ?? []).length > 0)
		)
		.map((candidate) => candidate.relation);
	const present = await probeRelations(db, runner, needed);
	const missing = needed.filter((relation) => !present.has(relation));
	if (missing.length > 0) {
		return {
			...empty,
			window: null,
			measures: [],
			freshness: null,
			unavailable: missing.map((relation) => ({
				level: request.level,
				source: spec.source,
				relation,
				reason: AMAZON_REPORT_SALES_AND_TRAFFIC.sources.find((candidate) =>
					candidate.relation === relation
				)?.whenAbsent ??
					`The relation ${relation} is not present on this database.`,
			})),
		};
	}

	const freshness = spec.source === "store"
		? await readFreshness(db, runner, {
			source: source.key,
			relation: source.relation,
			rule: "Latest date whose storefront session total reaches half the median of the store's 14 most " +
				"recent present dates. A row count would prove nothing here: this relation publishes exactly " +
				"one row per day whether or not Amazon has filled it in.",
			query: storeFreshnessQuery(stores),
		})
		: await readFreshness(db, runner, {
			source: source.key,
			relation: source.relation,
			rule: "Latest date whose row count reaches half the median of the store's 14 most recent present " +
				"dates. The failure mode is a placeholder day with a handful of rows, which a row-count floor " +
				"catches and a fixed lag does not.",
			query: skuByDayFreshnessQuery(stores),
		});

	// A store-level report that Amazon does not publish for this seller looks
	// exactly like this: the relation exists and holds no usable date. The levels
	// it serves are omitted rather than filled from the SKU sum, which would be a
	// number Amazon does not publish and which is knowably too high.
	if (freshness.anchorDate === null) {
		return {
			...empty,
			window: null,
			measures: [],
			freshness,
			unavailable: [{
				level: request.level,
				source: spec.source,
				relation: source.relation,
				reason: `${source.whenAbsent} No date in ${source.relation} passes the completeness rule for the ` +
					`stores in scope, so there is no window this level can be answered over.`,
			}],
		};
	}

	const window = resolveCanonicalWindow(request.window, freshness.anchorDate);
	const measures = selectMeasures(request, source.sourceGrainLevel);
	const rows = await runLevelQuery(db, runner, {
		request,
		keyColumns: keyColumnsForMeasures(spec, measures),
		sourceKey: spec.source,
		stores,
		window,
		measures,
	});

	return { ...empty, window, measures, freshness, unavailable: [], rows };
}

/**
 * The measures to compute, and the ones a ratio needs even when the caller did
 * not ask for them.
 *
 * A `NON_ADDITIVE` measure survives only when the request reads the source's own
 * rows one for one: the level must BE the source grain and the time bucket must
 * be a single day. Both halves matter — `buyBoxPercentage` is as undefined
 * across a week as it is across a family, because Amazon publishes the
 * percentage without the weights needed to combine it either way.
 */
function selectMeasures(
	request: AmazonReportSalesAndTrafficRequest,
	sourceGrainLevel: CanonicalLevel,
): readonly CanonicalMeasure[] {
	const atSourceGrain = request.level === sourceGrainLevel && request.timeGranularity === "DAY";
	const offered = measuresForLevel(AMAZON_REPORT_SALES_AND_TRAFFIC, request.level)
		.filter((measure) => measure.additivity.kind !== "NON_ADDITIVE" || atSourceGrain);

	const asked = request.measures;
	if (asked === undefined) {
		return offered;
	}
	const unknown = asked.filter((name) => !offered.some((measure) => measure.name === name));
	if (unknown.length > 0) {
		throw new Error(
			`AmazonReport_SALES_AND_TRAFFIC does not offer ${unknown.join(", ")} at level ${request.level} / ` +
				`${request.timeGranularity}. Offered: ${offered.map((measure) => measure.name).join(", ")}`,
		);
	}
	// A ratio is recomputed from its numerator and denominator at the output
	// grain, so both have to be computed even when the caller wanted only the
	// ratio. Averaging the source rows' ratios instead is the wrong answer that
	// looks right.
	const wanted = new Set(asked);
	for (const measure of offered) {
		if (wanted.has(measure.name) && measure.additivity.kind === "RATIO") {
			wanted.add(measure.additivity.numerator);
			wanted.add(measure.additivity.denominator);
		}
	}
	return offered.filter((measure) => wanted.has(measure.name));
}

/**
 * Everything the level query needs, after the declaration has been consulted.
 *
 * Exported for the unit tests, which assert on the COMPILED SQL rather than on
 * query results: the level rules that matter here — the marketplace in the
 * PARENT_ASIN key and its absence from the ASIN key, the `dateGranularity`
 * filter, the per-country family resolution — are all properties of the text,
 * and a test that reads the text catches a regression without a database.
 */
export interface LevelQueryParams {
	readonly request: AmazonReportSalesAndTrafficRequest;
	readonly keyColumns: readonly string[];
	readonly sourceKey: string;
	readonly stores: readonly StoreRef[];
	readonly window: { readonly dateFirst: string; readonly dateLast: string };
	readonly measures: readonly CanonicalMeasure[];
}

/** The database value of one selected column, before it is sorted into key or measure. */
export type CellValue = string | number | null;

async function runLevelQuery(
	db: Kysely<DB>,
	runner: CanonicalQueryRunner,
	params: LevelQueryParams,
): Promise<readonly AmazonReportSalesAndTrafficRow[]> {
	const rows = await executeCompiled(runner, compileLevelQuery(db, params));
	return Array.from(rows, (row) => buildRow(row, params.keyColumns, params.measures));
}

/** Build and compile the level query, without executing it. */
export function compileLevelQuery(
	db: Kysely<DB>,
	params: LevelQueryParams,
): CompiledQuery<Record<string, CellValue>> {
	const { request, keyColumns, measures } = params;
	const bucket = timeBucket(request.timeGranularity, params.window);
	const keyExpressions = keyColumns.map((column) => keyExpression(params.sourceKey, column));

	const selections: AliasedRawBuilder<CellValue, string>[] = [
		sql<CellValue>`${bucket.label}`.as("period"),
		...keyColumns.map((column, index) => sql<CellValue>`${keyExpressions[index] ?? sql`NULL`}`.as(column)),
		...measures
			.filter((measure) => measure.additivity.kind !== "RATIO")
			.map((measure) => sql<CellValue>`${aggregate(params.sourceKey, measure)}`.as(measure.name)),
	];
	const grouping = [...(bucket.groupBy === null ? [] : [bucket.groupBy]), ...keyExpressions];

	// The two branches are spelled out rather than shared, because each carries
	// its own relation types through `select`/`groupBy` and that is precisely the
	// checking Kysely is here for: a renamed column on either relation is a
	// compile error at the `selectFrom`/`innerJoin` above.
	return params.sourceKey === "store"
		? withGrouping(storeQuery(db, params).select(selections), grouping).compile()
		: withGrouping(skuByDayQuery(db, params).select(selections), grouping).compile();
}

/**
 * Group and order by the same expressions.
 *
 * Generic over the builder so both source branches share it: the two have
 * different relation types and there is no common supertype worth naming.
 */
function withGrouping<
	Q extends {
		groupBy(expressions: readonly RawBuilder<unknown>[]): Q;
		orderBy(expression: RawBuilder<unknown>): Q;
	},
>(query: Q, grouping: readonly RawBuilder<unknown>[]): Q {
	if (grouping.length === 0) {
		return query;
	}
	// One `orderBy` call per expression: the array form is deprecated in Kysely
	// 0.29 and warns on every compile.
	let ordered = query.groupBy(grouping);
	for (const expression of grouping) {
		ordered = ordered.orderBy(expression);
	}
	return ordered;
}

/** Split one database row into its key columns and its measures, recomputing every ratio. */
function buildRow(
	row: Readonly<Record<string, CellValue>>,
	keyColumns: readonly string[],
	measures: readonly CanonicalMeasure[],
): AmazonReportSalesAndTrafficRow {
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
	// Recomputed from the numerator and denominator AT THIS GRAIN. Averaging the
	// source rows' percentages would weight a SKU with three sessions the same as
	// one with three thousand.
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

/**
 * The time bucket, as a label expression and the expression to group by.
 *
 * WEEK and MONTH are labelled by the period's LAST date, matching the existing
 * `loadTraffic` so the two can be compared row for row.
 */
function timeBucket(
	granularity: CanonicalTimeGranularity,
	window: { readonly dateFirst: string; readonly dateLast: string },
): { readonly label: RawBuilder<unknown>; readonly groupBy: RawBuilder<unknown> | null } {
	switch (granularity) {
		case "DAY":
			return { label: sql`${sql.ref("t.date")}::text`, groupBy: sql`${sql.ref("t.date")}` };
		case "WEEK":
			return {
				label: sql`(date_trunc('week', ${sql.ref("t.date")})::date + 6)::text`,
				groupBy: sql`date_trunc('week', ${sql.ref("t.date")})`,
			};
		case "MONTH":
			return {
				label: sql`(date_trunc('month', ${
					sql.ref("t.date")
				}) + INTERVAL '1 month' - INTERVAL '1 day')::date::text`,
				groupBy: sql`date_trunc('month', ${sql.ref("t.date")})`,
			};
		case "TOTAL":
			return { label: sql`${`${window.dateFirst}/${window.dateLast}`}::text`, groupBy: null };
	}
}

/**
 * The expression that produces one key column at one level.
 *
 * This function is where the level rules live, and the two that matter are both
 * visible in it: `PARENT_ASIN` selects `marketplace_id` alongside the parent
 * because Amazon assigns a different parent per marketplace, and `ASIN` selects
 * no marketplace at all because the same ASIN is the same product everywhere.
 */
function keyExpression(sourceKey: string, column: string): RawBuilder<unknown> {
	if (column === "currency") {
		return currencyExpression();
	}
	if (sourceKey === "store") {
		switch (column) {
			case "merchantId":
				return sql`${sql.ref("t.merchantId")}`;
			case "marketplaceId":
				return sql`${sql.ref("t.marketplaceId")}`;
			case "countryCode":
				return sql`${sql.ref("s.countryCode")}`;
		}
		throw new Error(`AmazonReport_SALES_AND_TRAFFIC store levels do not know the key column ${column}`);
	}
	switch (column) {
		case "merchantId":
			return sql`${sql.ref("t.merchantId")}`;
		case "marketplaceId":
			return sql`${sql.ref("t.marketplaceId")}`;
		case "sku":
			return sql`${sql.ref("t.sku")}`;
		case "asin":
			return sql`${sql.ref("t.childAsin")}`;
		case "parentAsin":
			return sql`${sql.ref("t.parentAsin")}`;
		case "family":
			return familyExpression();
	}
	throw new Error(`AmazonReport_SALES_AND_TRAFFIC product levels do not know the key column ${column}`);
}

/**
 * The family an ASIN belongs to, resolved per country.
 *
 * `countryToFamily` is a per-country OVERRIDE map (`{ "US": "family-us" }`), so
 * an ASIN can belong to different families in different countries and reading
 * the flat `family` column alone reports the wrong one wherever an override
 * exists. Resolving per (ASIN, country) BEFORE grouping means a cross-country
 * roll-up still groups each row under the family that row's country assigns.
 *
 * The fallback to `(unmapped)` is what stops an unconfigured ASIN from vanishing
 * from a FAMILY roll-up: the resolved view `brand_ontology_amazon_asin` lists
 * only ASINs that resolve to a variant or a family and is therefore not a
 * complete ASIN list, which is why this joins the base configuration table
 * instead.
 */
function familyExpression(): RawBuilder<unknown> {
	return sql`COALESCE(${sql.ref("f.countryToFamily")}->>${sql.ref("s.countryCode")}, ${sql.ref("f.family")}, ${
		sql.lit(UNMAPPED_FAMILY)
	})`;
}

/** The aggregate for one measure, from whichever of the two relations serves it. */
function aggregate(sourceKey: string, measure: CanonicalMeasure): RawBuilder<unknown> {
	const salesMeasures = sourceKey === "store" ? STORE_SALES_MEASURES : SKU_SALES_MEASURES;
	const block = salesMeasures.has(measure.name) ? sql.ref("t.sales") : sql.ref("t.traffic");
	const field = sql.lit(measure.name);
	if (measure.value?.kind === "MONEY") {
		return sql`SUM((${block}->${field}->>'amount')::numeric)`;
	}
	// NON_ADDITIVE measures only reach here at the source grain, where the
	// group holds exactly one row and MAX is that row's value.
	const value = sql`(${block}->>${field})::float8`;
	return measure.additivity.kind === "NON_ADDITIVE" ? sql`MAX(${value})` : sql`COALESCE(SUM(${value}), 0)`;
}

/** Measures that live in the store relation's `sales` block rather than its `traffic` block. */
const STORE_SALES_MEASURES: ReadonlySet<string> = new Set([
	"orderedProductSales",
	"unitsOrdered",
	"unitsOrderedB2B",
	"totalOrderItems",
]);

/** Measures in the SKU relation's `sales` block rather than its `traffic` block. */
const SKU_SALES_MEASURES: ReadonlySet<string> = STORE_SALES_MEASURES;

/** Currency stated by the report for ordered-product sales on this source row. */
function currencyExpression(): RawBuilder<unknown> {
	return sql`${sql.ref("t.sales")}->'orderedProductSales'->>'currencyCode'`;
}

/**
 * The SKU-grain half: the source report table, joined to the store directory.
 *
 * The store join is not decoration. It supplies the country a FAMILY override is
 * resolved against, it supplies the country filter, and its `isReal` predicate
 * removes the synthetic storefronts Amazon returns alongside genuine ones (the
 * Non-Amazon set, the invoicing shadow marketplace). `isActive` is deliberately
 * NOT filtered: deactivating a store today does not unmake the traffic it had
 * last month, and dropping it would silently change history.
 */
function skuByDayQuery(db: Kysely<DB>, params: LevelQueryParams) {
	const needsFamily = params.request.level === "FAMILY" || (params.request.families ?? []).length > 0;
	const base = db
		.selectFrom("amzreport_SALES_AND_TRAFFIC__skuByDay as t")
		.innerJoin("amazon_store as s", (join) =>
			join
				.onRef("s.merchantId", "=", "t.merchantId")
				.onRef("s.marketplaceId", "=", "t.marketplaceId"))
		.$if(needsFamily, (qb) => qb.leftJoin("brand_config_amazon_asin as f", "f.asin", "t.childAsin"))
		.where("s.isReal", "=", true)
		.where(dateBetween(params.window))
		.$if(params.stores.length > 0, (qb) => qb.where(storePairs(params.stores, "t.merchantId", "t.marketplaceId")))
		.$if(
			(params.request.countryCodes ?? []).length > 0,
			(qb) => qb.where(inList(sql.ref("s.countryCode"), params.request.countryCodes ?? [])),
		)
		.$if(
			(params.request.asins ?? []).length > 0,
			(qb) => qb.where(inList(sql.ref("t.childAsin"), params.request.asins ?? [])),
		)
		.$if(
			(params.request.families ?? []).length > 0,
			(qb) => qb.where(inList(familyExpression(), params.request.families ?? [])),
		);
	return base;
}

/**
 * The storefront half.
 *
 * `dateGranularity = 'DAY'` is the filter this table cannot be read without. DAY,
 * WEEK and MONTH rows coexist in it because all three are in its primary key, so
 * a query that omits the filter counts every day up to three times. There is no
 * equivalent column on the SKU-grain relation, which is exactly why it is easy to
 * forget here.
 */
function storeQuery(db: Kysely<DB>, params: LevelQueryParams) {
	return db
		.selectFrom("amzreport_SALES_AND_TRAFFIC__store as t")
		.innerJoin("amazon_store as s", (join) =>
			join
				.onRef("s.merchantId", "=", "t.merchantId")
				.onRef("s.marketplaceId", "=", "t.marketplaceId"))
		.where("t.dateGranularity", "=", "DAY")
		.where("s.isReal", "=", true)
		.where(dateBetween(params.window))
		.$if(params.stores.length > 0, (qb) => qb.where(storePairs(params.stores, "t.merchantId", "t.marketplaceId")))
		.$if(
			(params.request.countryCodes ?? []).length > 0,
			(qb) => qb.where(inList(sql.ref("s.countryCode"), params.request.countryCodes ?? [])),
		);
}

/** `t.date BETWEEN ... AND ...`, both ends inclusive and both bound. */
function dateBetween(window: { readonly dateFirst: string; readonly dateLast: string }): Expression<boolean> {
	return sql<boolean>`${sql.ref("t.date")} >= ${window.dateFirst}::date AND ${
		sql.ref("t.date")
	} <= ${window.dateLast}::date`;
}

/** `(merchant, marketplace) IN ((..),(..))` over the requested stores, every value bound. */
function storePairs(
	stores: readonly StoreRef[],
	merchantColumn: string,
	marketplaceColumn: string,
): Expression<boolean> {
	const pairs = stores.map((store) => sql`(${store.merchantId}, ${store.marketplaceId})`);
	return sql<boolean>`(${sql.ref(merchantColumn)}, ${sql.ref(marketplaceColumn)}) IN (${sql.join(pairs)})`;
}

/** `expr IN (...)` with every value bound. */
function inList(expression: RawBuilder<unknown>, values: readonly string[]): Expression<boolean> {
	return sql<boolean>`${expression} IN (${sql.join(values.map((value) => sql`${value}`))})`;
}
