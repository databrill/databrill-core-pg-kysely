import { type AliasedRawBuilder, type CompiledQuery, type Expression, type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "../../types.ts";
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
import { type CanonicalQueryRunner, executeCompiled } from "../execute.ts";
import { ordersFreshnessQuery, readFreshness, type SourceFreshness, type StoreRef } from "../freshness.ts";
import { probeRelations } from "../relations.ts";
import { type CanonicalResolvedWindow, type CanonicalWindow, resolveCanonicalWindow } from "../window.ts";
import { AMAZON_ORDERS } from "./declaration.ts";

export type { StoreRef };

export interface AmazonOrdersRequest {
	readonly level: CanonicalLevel;
	readonly timeGranularity: CanonicalTimeGranularity;
	readonly window: CanonicalWindow;
	/** Empty or absent means every real store on the database. */
	readonly stores?: readonly StoreRef[];
	readonly countryCodes?: readonly string[];
	readonly asins?: readonly string[];
	readonly families?: readonly string[];
	/** False by default. True includes sales channels whose name starts with `Non-Amazon`. */
	readonly includeNonAmazonSalesChannels?: boolean;
	/** ISO 4217 target. Absent means each store's native marketplace currency. */
	readonly targetCurrency?: string;
	/** Absent means every measure the declaration offers at this level. */
	readonly measures?: readonly string[];
}

export interface AmazonOrdersRow {
	readonly period: string;
	readonly key: Readonly<Record<string, string>>;
	readonly measures: Readonly<Record<string, number | null>>;
}

export interface AmazonOrdersResult {
	readonly declaration: string;
	readonly level: CanonicalLevel;
	readonly timeGranularity: CanonicalTimeGranularity;
	readonly window: CanonicalResolvedWindow | null;
	readonly measures: readonly CanonicalMeasure[];
	readonly freshness: SourceFreshness | null;
	readonly caveats: readonly CanonicalCaveat[];
	readonly unavailable: readonly CanonicalUnavailability[];
	readonly rows: readonly AmazonOrdersRow[];
}

const UNMAPPED_FAMILY = "(unmapped)";

/** Read `AmazonOrders` at one declared level. */
export async function readAmazonOrders(
	db: Kysely<DB>,
	runner: CanonicalQueryRunner,
	request: AmazonOrdersRequest,
): Promise<AmazonOrdersResult> {
	const spec = levelSpec(AMAZON_ORDERS, request.level);
	if (spec === undefined) {
		throw new Error(
			`AmazonOrders does not offer the level ${request.level}. Offered: ${
				AMAZON_ORDERS.levels.map((entry) => entry.level).join(", ")
			}`,
		);
	}
	const source = AMAZON_ORDERS.sources.find((candidate) => candidate.key === spec.source);
	if (source === undefined || source.role !== "FACT") {
		throw new Error(`AmazonOrders level ${request.level} names an undeclared fact source ${spec.source}`);
	}

	const stores = request.stores ?? [];
	const caveats = caveatsForLevel(AMAZON_ORDERS, request.level);
	const empty = {
		declaration: AMAZON_ORDERS.name,
		level: request.level,
		timeGranularity: request.timeGranularity,
		caveats,
		rows: [],
	} as const;

	const needed = AMAZON_ORDERS.sources
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
				reason: AMAZON_ORDERS.sources.find((candidate) => candidate.relation === relation)?.whenAbsent ??
					`The relation ${relation} is not present on this database.`,
			})),
		};
	}

	const freshness = await readFreshness(db, runner, {
		source: source.key,
		relation: source.relation,
		rule: "The newest observed order date, capped at the last marketplace-local calendar day after a " +
			"two-hour post-midnight buffer. ALL_ORDERS arrives hourly; the buffer covers its measured p95 " +
			"delay and prevents a partially elapsed day from becoming the trailing-window anchor.",
		query: ordersFreshnessQuery(stores),
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
				reason: `${source.whenAbsent} No order date in the 90-day freshness scan can anchor this request.`,
			}],
		};
	}

	const window = resolveCanonicalWindow(request.window, freshness.anchorDate);
	const measures = selectMeasures(request);
	const rows = await runLevelQuery(db, runner, {
		request,
		keyColumns: keyColumnsForMeasures(spec, measures),
		stores,
		window,
		measures,
	});
	return { ...empty, window, measures, freshness, unavailable: [], rows };
}

function selectMeasures(request: AmazonOrdersRequest): readonly CanonicalMeasure[] {
	const offered = measuresForLevel(AMAZON_ORDERS, request.level);
	if (request.measures === undefined) {
		return offered;
	}
	const unknown = request.measures.filter((name) => !offered.some((measure) => measure.name === name));
	if (unknown.length > 0) {
		throw new Error(
			`AmazonOrders does not offer ${unknown.join(", ")} at level ${request.level}. Offered: ${
				offered.map((measure) => measure.name).join(", ")
			}`,
		);
	}
	const wanted = new Set(request.measures);
	return offered.filter((measure) => wanted.has(measure.name));
}

export interface OrdersLevelQueryParams {
	readonly request: AmazonOrdersRequest;
	readonly keyColumns: readonly string[];
	readonly stores: readonly StoreRef[];
	readonly window: { readonly dateFirst: string; readonly dateLast: string };
	readonly measures: readonly CanonicalMeasure[];
}

export type OrderCellValue = string | number | null;

async function runLevelQuery(
	db: Kysely<DB>,
	runner: CanonicalQueryRunner,
	params: OrdersLevelQueryParams,
): Promise<readonly AmazonOrdersRow[]> {
	const rows = await executeCompiled(runner, compileOrdersLevelQuery(db, params));
	return Array.from(rows, (row) => buildRow(row, params.keyColumns, params.measures));
}

/** Build and compile one orders query without executing it. */
export function compileOrdersLevelQuery(
	db: Kysely<DB>,
	params: OrdersLevelQueryParams,
): CompiledQuery<Record<string, OrderCellValue>> {
	const bucket = timeBucket(params.request.timeGranularity, params.window);
	const currency = actualCurrencyExpression(params.request.targetCurrency);
	const keyExpressions = params.keyColumns.map((column) => keyExpression(column, currency));
	const selections: AliasedRawBuilder<OrderCellValue, string>[] = [
		sql<OrderCellValue>`${bucket.label}`.as("period"),
		...params.keyColumns.map((column, index) =>
			sql<OrderCellValue>`${keyExpressions[index] ?? sql`NULL`}`.as(column)
		),
		...params.measures.map((measure) =>
			sql<OrderCellValue>`${aggregate(measure, params.request.targetCurrency)}`.as(measure.name)
		),
	];
	// Group by selection positions. The currency expression contains a bound
	// target value; repeating that expression in GROUP BY would assign fresh
	// placeholder numbers, which PostgreSQL correctly treats as a different
	// expression even though the parameter values happen to match.
	const grouping = [
		...(bucket.groupBy === null ? [] : [sql.raw("1")]),
		...params.keyColumns.map((_column, index) => sql.raw(String(index + 2))),
	];
	return withGrouping(ordersQuery(db, params).select(selections), grouping).compile();
}

function ordersQuery(db: Kysely<DB>, params: OrdersLevelQueryParams) {
	const sourceCurrency = sourceCurrencyExpression();
	const targetCurrency = targetCurrencyExpression(params.request.targetCurrency);
	const needsFamily = params.request.level === "FAMILY" || (params.request.families ?? []).length > 0;
	return db
		.selectFrom("amzreport_ALL_ORDERS as o")
		.innerJoin("amazon_store as s", (join) =>
			join
				.onRef("s.merchantId", "=", "o.merchant_id")
				.onRef("s.marketplaceId", "=", "o.marketplace_id"))
		.innerJoin("amazon_marketplace as m", "m.marketplace_id", "o.marketplace_id")
		.$if(
			params.request.level === "PARENT_ASIN",
			(qb) =>
				qb.leftJoin("amzspapi_catalog_items_v20220401__catalogitem as c", (join) =>
					join
						.onRef("c.marketplace_code", "=", "m.marketplace_code")
						.onRef("c.asin", "=", "o.asin")),
		)
		.$if(needsFamily, (qb) => qb.leftJoin("brand_config_amazon_asin as f", "f.asin", "o.asin"))
		.leftJoinLateral(
			(eb) =>
				eb
					.selectFrom("fx_ecb_rate_history as fromFxRows")
					.select("fromFxRows.value as value")
					.where("fromFxRows.timeFormat", "=", "P1D")
					.where(sql<boolean>`${sql.ref("fromFxRows.unit")} = ${sourceCurrency}`)
					.orderBy(
						sql`CASE WHEN ${sql.ref("fromFxRows.period")} <= ${
							sql.ref("o.localdate")
						}::text THEN 0 ELSE 1 END`,
					)
					.orderBy(
						sql`CASE WHEN ${sql.ref("fromFxRows.period")} <= ${sql.ref("o.localdate")}::text THEN ${
							sql.ref("fromFxRows.period")
						} END`,
						"desc",
					)
					.orderBy(
						sql`CASE WHEN ${sql.ref("fromFxRows.period")} > ${sql.ref("o.localdate")}::text THEN ${
							sql.ref("fromFxRows.period")
						} END`,
						"asc",
					)
					.limit(1)
					.as("fromFx"),
			(join) => join.onTrue(),
		)
		.leftJoinLateral(
			(eb) =>
				eb
					.selectFrom("fx_ecb_rate_history as toFxRows")
					.select("toFxRows.value as value")
					.where("toFxRows.timeFormat", "=", "P1D")
					.where(sql<boolean>`${sql.ref("toFxRows.unit")} = ${targetCurrency}`)
					.orderBy(
						sql`CASE WHEN ${sql.ref("toFxRows.period")} <= ${
							sql.ref("o.localdate")
						}::text THEN 0 ELSE 1 END`,
					)
					.orderBy(
						sql`CASE WHEN ${sql.ref("toFxRows.period")} <= ${sql.ref("o.localdate")}::text THEN ${
							sql.ref("toFxRows.period")
						} END`,
						"desc",
					)
					.orderBy(
						sql`CASE WHEN ${sql.ref("toFxRows.period")} > ${sql.ref("o.localdate")}::text THEN ${
							sql.ref("toFxRows.period")
						} END`,
						"asc",
					)
					.limit(1)
					.as("toFx"),
			(join) => join.onTrue(),
		)
		.where("s.isReal", "=", true)
		.where(sql<boolean>`COALESCE(${sql.ref("o.order_status")}, '') <> 'Cancelled'`)
		.where(sql<boolean>`COALESCE(${sql.ref("o.item_status")}, '') <> 'Cancelled'`)
		.where("o.asin", "is not", null)
		.where(dateBetween(params.window))
		.$if(
			params.request.includeNonAmazonSalesChannels !== true,
			(qb) => qb.where(sql<boolean>`COALESCE(${sql.ref("o.sales_channel")}, '') NOT LIKE 'Non-Amazon%'`),
		)
		.$if(params.stores.length > 0, (qb) => qb.where(storePairs(params.stores)))
		.$if(
			(params.request.countryCodes ?? []).length > 0,
			(qb) => qb.where(inList(sql.ref("m.country_code"), params.request.countryCodes ?? [])),
		)
		.$if(
			(params.request.asins ?? []).length > 0,
			(qb) => qb.where(inList(sql.ref("o.asin"), params.request.asins ?? [])),
		)
		.$if(
			(params.request.families ?? []).length > 0,
			(qb) => qb.where(inList(familyExpression(), params.request.families ?? [])),
		);
}
function withGrouping<
	Q extends {
		groupBy(expressions: readonly RawBuilder<unknown>[]): Q;
		orderBy(expression: RawBuilder<unknown>): Q;
	},
>(query: Q, grouping: readonly RawBuilder<unknown>[]): Q {
	if (grouping.length === 0) {
		return query;
	}
	let ordered = query.groupBy(grouping);
	for (const expression of grouping) {
		ordered = ordered.orderBy(expression);
	}
	return ordered;
}

function buildRow(
	row: Readonly<Record<string, OrderCellValue>>,
	keyColumns: readonly string[],
	measures: readonly CanonicalMeasure[],
): AmazonOrdersRow {
	const key: Record<string, string> = {};
	for (const column of keyColumns) {
		const value = row[column];
		key[column] = value === null || value === undefined ? "" : String(value);
	}
	const values: Record<string, number | null> = {};
	for (const measure of measures) {
		const value = row[measure.name];
		values[measure.name] = value === null || value === undefined
			? null
			: typeof value === "number"
			? value
			: Number(value);
	}
	const period = row["period"];
	return { period: period === null || period === undefined ? "" : String(period), key, measures: values };
}

function timeBucket(
	granularity: CanonicalTimeGranularity,
	window: { readonly dateFirst: string; readonly dateLast: string },
): { readonly label: RawBuilder<unknown>; readonly groupBy: RawBuilder<unknown> | null } {
	switch (granularity) {
		case "DAY":
			return { label: sql`${sql.ref("o.localdate")}::text`, groupBy: sql`${sql.ref("o.localdate")}` };
		case "WEEK":
			return {
				label: sql`(date_trunc('week', ${sql.ref("o.localdate")})::date + 6)::text`,
				groupBy: sql`date_trunc('week', ${sql.ref("o.localdate")})`,
			};
		case "MONTH":
			return {
				label: sql`(date_trunc('month', ${
					sql.ref("o.localdate")
				}) + INTERVAL '1 month' - INTERVAL '1 day')::date::text`,
				groupBy: sql`date_trunc('month', ${sql.ref("o.localdate")})`,
			};
		case "TOTAL":
			return { label: sql`${`${window.dateFirst}/${window.dateLast}`}::text`, groupBy: null };
	}
}

function keyExpression(column: string, currency: RawBuilder<unknown>): RawBuilder<unknown> {
	switch (column) {
		case "merchantId":
			return sql`${sql.ref("o.merchant_id")}`;
		case "marketplaceId":
			return sql`${sql.ref("o.marketplace_id")}`;
		case "countryCode":
			return sql`${sql.ref("m.country_code")}`;
		case "family":
			return familyExpression();
		case "parentAsin":
			return sql`COALESCE(NULLIF(${sql.ref("c.parent_asin")}, ''), ${sql.ref("o.asin")})`;
		case "asin":
			return sql`${sql.ref("o.asin")}`;
		case "sku":
			return sql`${sql.ref("o.sku")}`;
		case "currency":
			return currency;
	}
	throw new Error(`AmazonOrders does not know the key column ${column}`);
}

function familyExpression(): RawBuilder<unknown> {
	return sql`COALESCE(${sql.ref("f.countryToFamily")}->>${sql.ref("m.country_code")}, ${sql.ref("f.family")}, ${
		sql.lit(UNMAPPED_FAMILY)
	})`;
}

function aggregate(measure: CanonicalMeasure, requestedTarget: string | undefined): RawBuilder<unknown> {
	switch (measure.name) {
		case "units":
			return sql`COALESCE(SUM(${sql.ref("o.quantity")}), 0)::float8`;
		case "orders":
			return sql`COUNT(DISTINCT (${sql.ref("o.merchant_id")}, ${sql.ref("o.amazon_order_id")}))::float8`;
		case "extendedPrice":
			return completeMoneyAggregate(sql`${sql.ref("o.item_price")}::numeric`, "o.item_price", requestedTarget);
		case "extendedPriceExclTax":
			return completeMoneyAggregate(
				sql`${sql.ref("o.vat_exclusive_item_price")}::numeric`,
				"o.vat_exclusive_item_price",
				requestedTarget,
			);
		case "itemTaxAmount":
			return sql`SUM(${convertMoney(sql`COALESCE(${sql.ref("o.item_tax")}, 0)::numeric`, requestedTarget)})`;
		case "shippingAmount":
			return sql`SUM(${
				convertMoney(
					sql`(COALESCE(${sql.ref("o.shipping_price")}, 0) + COALESCE(${
						sql.ref("o.shipping_tax")
					}, 0))::numeric`,
					requestedTarget,
				)
			})`;
	}
	throw new Error(`AmazonOrders does not know the measure ${measure.name}`);
}

function completeMoneyAggregate(
	amount: RawBuilder<unknown>,
	sourceColumn: string,
	requestedTarget: string | undefined,
): RawBuilder<unknown> {
	return sql`CASE WHEN COUNT(${sql.ref(sourceColumn)}) = COUNT(*) THEN SUM(${
		convertMoney(amount, requestedTarget)
	}) ELSE NULL END`;
}

function convertMoney(amount: RawBuilder<unknown>, requestedTarget: string | undefined): RawBuilder<unknown> {
	const source = sourceCurrencyExpression();
	const target = targetCurrencyExpression(requestedTarget);
	const fromRate = fromRateExpression(source);
	const toRate = toRateExpression(target);
	return sql`CASE
		WHEN ${source} = ${target} THEN ${amount}
		WHEN ${fromRate} IS NOT NULL AND ${toRate} IS NOT NULL
			THEN ${amount} / (${fromRate})::numeric * (${toRate})::numeric
		ELSE ${amount}
	END`;
}

function actualCurrencyExpression(requestedTarget: string | undefined): RawBuilder<unknown> {
	const source = sourceCurrencyExpression();
	const target = targetCurrencyExpression(requestedTarget);
	const fromRate = fromRateExpression(source);
	const toRate = toRateExpression(target);
	return sql`CASE
		WHEN ${source} = ${target} THEN ${target}
		WHEN ${fromRate} IS NOT NULL AND ${toRate} IS NOT NULL THEN ${target}
		ELSE ${source}
	END`;
}

function sourceCurrencyExpression(): RawBuilder<unknown> {
	return sql`COALESCE(${sql.ref("o.currency")}, ${sql.ref("m.currency")})`;
}

function targetCurrencyExpression(requestedTarget: string | undefined): RawBuilder<unknown> {
	return requestedTarget === undefined ? sql`${sql.ref("m.currency")}` : sql`${requestedTarget}`;
}

function fromRateExpression(source: RawBuilder<unknown>): RawBuilder<unknown> {
	return sql`CASE WHEN ${source} = 'EUR' THEN 1::numeric ELSE ${sql.ref("fromFx.value")}::numeric END`;
}

function toRateExpression(target: RawBuilder<unknown>): RawBuilder<unknown> {
	return sql`CASE WHEN ${target} = 'EUR' THEN 1::numeric ELSE ${sql.ref("toFx.value")}::numeric END`;
}

function dateBetween(window: { readonly dateFirst: string; readonly dateLast: string }): Expression<boolean> {
	return sql<boolean>`${sql.ref("o.localdate")} >= ${window.dateFirst}::date AND ${
		sql.ref("o.localdate")
	} <= ${window.dateLast}::date`;
}

function storePairs(stores: readonly StoreRef[]): Expression<boolean> {
	const pairs = stores.map((store) => sql`(${store.merchantId}, ${store.marketplaceId})`);
	return sql<boolean>`(${sql.ref("o.merchant_id")}, ${sql.ref("o.marketplace_id")}) IN (${sql.join(pairs)})`;
}

function inList(expression: RawBuilder<unknown>, values: readonly string[]): Expression<boolean> {
	return sql<boolean>`${expression} IN (${sql.join(values.map((value) => sql`${value}`))})`;
}
