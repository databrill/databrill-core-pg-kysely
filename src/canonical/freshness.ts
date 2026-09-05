import { type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "../types.ts";
import { type CanonicalQueryRunner, executeCompiled } from "./execute.ts";
import { col, qualified, rel } from "./names.ts";

/**
 * The last date a source can be trusted for, per store — and why `MAX(date)` is
 * not that date.
 *
 * The sales-and-traffic report's traffic metrics fill three to four days after
 * the report date, and the day-after run lands sales rows with page views of
 * zero. The newest date present in the table is therefore routinely a
 * placeholder day, whose row count and session count collapse to a small
 * fraction of a normal day's, while most marketplaces genuinely stopped one or
 * two days earlier. A reader that treats "a row exists" as "the day is present"
 * reports near-zero traffic for the most recent days and no consumer can tell.
 *
 * So the rule is a COMPLETENESS test, not a fixed lag: the latest date whose
 * signal reaches a fraction of the store's recent typical signal. A fixed lag
 * cannot work here — the step is two days one day and one day the next.
 *
 * The signal differs by source because the failure looks different in each:
 *
 * - the SKU-level source publishes one row per SKU per day, so a placeholder day
 *   shows up as a collapsed ROW COUNT;
 * - the store-level source publishes exactly one row per day whatever happens,
 *   so a row count says nothing and the signal has to be the metric itself.
 *
 * `maxDefinitiveDate` is the name the agency codebase already uses for this
 * (`r2601-query.ts`, and a `ReportStatus` table whose values agree with the rule
 * below), so this reader adopts that vocabulary rather than inventing a second
 * one.
 */

/** The completeness rule's constants, together so they can be argued about in one place. */
export const FRESHNESS_RULE = {
	/**
	 * A date is definitive when its signal is at least this fraction of the
	 * store's baseline. Deliberately loose: real day-to-day variation on a
	 * healthy store is well inside 2x, while a placeholder day is an order of
	 * magnitude down, so anything from 0.3 to 0.7 separates them equally well and
	 * a tighter threshold would only start rejecting slow weekends.
	 */
	fraction: 0.5,
	/** Baseline = the median signal over this many of the store's most recent present dates. */
	baselineDays: 14,
	/**
	 * How far back the completeness scan looks, in days before today.
	 *
	 * A scan bound, NOT a window anchor: it exists so the freshness probe reads a
	 * bounded slice rather than the whole table, and it is far longer than any
	 * observed reporting lag. A store whose data stopped longer ago than this
	 * reports no definitive date at all, rather than inventing one.
	 */
	scanDays: 90,
} as const;

/**
 * Completeness rule for the hourly ALL_ORDERS source.
 *
 * Unlike sales-and-traffic, ALL_ORDERS does not publish placeholder days. Its
 * incomplete value is the marketplace's current calendar day, which grows with
 * every hourly report. The report's measured p95 lag is about 127 minutes, so a
 * day becomes eligible two hours after marketplace-local midnight. The reader
 * also refuses to move beyond the latest order date it has observed, which
 * exposes a stale source instead of advancing on the clock alone.
 */
export const ORDERS_FRESHNESS_RULE = {
	midnightBufferHours: 2,
	scanDays: 90,
} as const;

/** Freshness of one source for one store. */
export interface StoreFreshness {
	readonly merchantId: string;
	readonly marketplaceId: string;
	/** The latest date with any row at all. Almost never the date to trust. */
	readonly maxPresentDate: string | null;
	/** The latest date passing the completeness rule, or null when no date does. */
	readonly maxDefinitiveDate: string | null;
	/** The baseline the rule compared against, so the answer can explain itself. */
	readonly baselineSignal: number | null;
}

export interface SourceFreshness {
	readonly source: string;
	readonly relation: string;
	/** What the completeness rule measured, in words, for a consumer that has to explain the number. */
	readonly rule: string;
	readonly perStore: readonly StoreFreshness[];
	/**
	 * The anchor a trailing window ends on: the EARLIEST `maxDefinitiveDate`
	 * across the stores in scope.
	 *
	 * Earliest rather than latest, because a multi-store answer whose window runs
	 * past one store's definitive date compares a complete store against an
	 * incomplete one — the bug this whole module exists to prevent. Null when no
	 * store in scope has a definitive date.
	 */
	readonly anchorDate: string | null;
}

export interface StoreRef {
	readonly merchantId: string;
	readonly marketplaceId: string;
}

/** One freshness row, as the query returns it. */
interface FreshnessRow {
	readonly merchantId: string;
	readonly marketplaceId: string;
	readonly maxPresentDate: string | null;
	readonly maxDefinitiveDate: string | null;
	readonly baselineSignal: number | null;
}

/**
 * Freshness of the SKU-level source, where the signal is the ROW COUNT.
 *
 * `stores` empty means every store on the database.
 */
export function skuByDayFreshnessQuery(stores: readonly StoreRef[]): RawBuilder<FreshnessRow> {
	return freshnessQuery({
		relation: rel("amzreport_SALES_AND_TRAFFIC__skuByDay"),
		merchantId: col("amzreport_SALES_AND_TRAFFIC__skuByDay", "merchantId"),
		marketplaceId: col("amzreport_SALES_AND_TRAFFIC__skuByDay", "marketplaceId"),
		date: col("amzreport_SALES_AND_TRAFFIC__skuByDay", "date"),
		signal: sql`COUNT(*)::float8`,
		extraWhere: null,
		stores,
	});
}

/**
 * Freshness of the store-level source, where the signal is the sessions metric
 * itself.
 *
 * `dateGranularity` is filtered here as everywhere else this table is touched:
 * DAY, WEEK and MONTH rows coexist in it because all three are in its primary
 * key, so an unfiltered scan counts one day up to three times.
 */
export function storeFreshnessQuery(stores: readonly StoreRef[]): RawBuilder<FreshnessRow> {
	return freshnessQuery({
		relation: rel("amzreport_SALES_AND_TRAFFIC__store"),
		merchantId: col("amzreport_SALES_AND_TRAFFIC__store", "merchantId"),
		marketplaceId: col("amzreport_SALES_AND_TRAFFIC__store", "marketplaceId"),
		date: col("amzreport_SALES_AND_TRAFFIC__store", "date"),
		signal: sql`SUM((${col("amzreport_SALES_AND_TRAFFIC__store", "traffic")}->>'sessions')::float8)`,
		extraWhere: sql`AND ${col("amzreport_SALES_AND_TRAFFIC__store", "dateGranularity")} = 'DAY'`,
		stores,
	});
}

/**
 * Freshness of Search Query Performance for one delivered report period type.
 *
 * SQP arrives as a closed WEEK or MONTH report, so latest present and latest
 * definitive are the same `dateLast`. The full store tuple and time unit are
 * pinned because they are the leading columns of the source primary key; a
 * workspace-wide grouped MAX needlessly scans the multi-million-row table.
 */
export function searchQueryPerformanceFreshnessQuery(
	stores: readonly StoreRef[],
	reportTimeUnit: "WEEK" | "MONTH",
): RawBuilder<FreshnessRow> {
	const merchantId = col("amzreport_SEARCH_QUERY_PERFORMANCE", "merchantId");
	const marketplaceId = col("amzreport_SEARCH_QUERY_PERFORMANCE", "marketplaceId");
	const dateLast = col("amzreport_SEARCH_QUERY_PERFORMANCE", "dateLast");
	const timeUnit = col("amzreport_SEARCH_QUERY_PERFORMANCE", "timeUnit");
	const storeFilter = stores.length === 0
		? sql``
		: sql`AND (${merchantId}, ${marketplaceId}) IN (${
			sql.join(stores.map((store) => sql`(${store.merchantId}, ${store.marketplaceId})`))
		})`;

	return sql<FreshnessRow>`
		SELECT ${merchantId} AS "merchantId",
		       ${marketplaceId} AS "marketplaceId",
		       MAX(${dateLast})::text AS "maxPresentDate",
		       MAX(${dateLast})::text AS "maxDefinitiveDate",
		       NULL::float8 AS "baselineSignal"
		FROM ${rel("amzreport_SEARCH_QUERY_PERFORMANCE")}
		WHERE ${timeUnit} = ${reportTimeUnit}
		${storeFilter}
		GROUP BY ${merchantId}, ${marketplaceId}
	`;
}

/**
 * Freshness of ALL_ORDERS, capped at the latest completed marketplace-local day.
 *
 * The two-hour buffer matches the measured p95 report delay and the shipped
 * r2601/r2604 date-window rule. A row-count fraction is specifically unsuitable:
 * a high-volume store can accumulate enough rows before its day is over to clear
 * the sessions reader's `FRESHNESS_RULE.fraction` threshold, so the fraction
 * would pass a day that is still filling.
 */
export function ordersFreshnessQuery(stores: readonly StoreRef[]): RawBuilder<FreshnessRow> {
	const merchantId = qualified("amzreport_ALL_ORDERS", "o", "merchant_id");
	const marketplaceId = qualified("amzreport_ALL_ORDERS", "o", "marketplace_id");
	const localdate = qualified("amzreport_ALL_ORDERS", "o", "localdate");
	const timeZone = qualified("amazon_marketplace", "m", "time_zone");
	const storeFilter = stores.length === 0
		? sql``
		: sql`AND (${merchantId}, ${marketplaceId}) IN (${
			sql.join(stores.map((store) => sql`(${store.merchantId}, ${store.marketplaceId})`))
		})`;

	return sql<FreshnessRow>`
		SELECT ${merchantId} AS "merchantId",
		       ${marketplaceId} AS "marketplaceId",
		       MAX(${localdate})::text AS "maxPresentDate",
		       LEAST(
		           MAX(${localdate}),
		           (
		               (CURRENT_TIMESTAMP AT TIME ZONE COALESCE(${timeZone}, 'UTC'))
		               - ${ORDERS_FRESHNESS_RULE.midnightBufferHours}::int * INTERVAL '1 hour'
		           )::date - 1
		       )::text AS "maxDefinitiveDate",
		       NULL::float8 AS "baselineSignal"
		FROM ${rel("amzreport_ALL_ORDERS")} o
		JOIN ${rel("amazon_marketplace")} m
		  ON ${qualified("amazon_marketplace", "m", "marketplace_id")} = ${marketplaceId}
		JOIN ${rel("amazon_store")} s
		  ON ${qualified("amazon_store", "s", "merchantId")} = ${merchantId}
		 AND ${qualified("amazon_store", "s", "marketplaceId")} = ${marketplaceId}
		WHERE ${localdate} >= CURRENT_DATE - ${ORDERS_FRESHNESS_RULE.scanDays}::int
		  AND ${localdate} IS NOT NULL
		  AND ${qualified("amazon_store", "s", "isReal")} = TRUE
		${storeFilter}
		GROUP BY ${merchantId}, ${marketplaceId}, ${timeZone}
	`;
}

interface FreshnessShape {
	readonly relation: RawBuilder<unknown>;
	readonly merchantId: RawBuilder<unknown>;
	readonly marketplaceId: RawBuilder<unknown>;
	readonly date: RawBuilder<unknown>;
	readonly signal: RawBuilder<unknown>;
	readonly extraWhere: RawBuilder<unknown> | null;
	readonly stores: readonly StoreRef[];
}

/**
 * One query per source: collapse to (store, date, signal), take the median
 * signal over the most recent {@link FRESHNESS_RULE}`.baselineDays` present
 * dates, and report the latest date clearing the fraction.
 *
 * The baseline is a median rather than a mean precisely because the days it is
 * meant to judge are inside the sample. Two or three collapsed days out of
 * fourteen move a median by nothing and a mean by a fifth.
 *
 * Written as SQL rather than through the query builder because Kysely 0.29's
 * `.with()` will not take a raw CTE body, and expressing `percentile_cont ...
 * WITHIN GROUP` and `MAX(...) FILTER (WHERE ...)` through the builder is longer
 * than the SQL and no clearer. Every identifier still goes through {@link rel} /
 * {@link col}, so a renamed relation or column is a compile error here too.
 */
function freshnessQuery(shape: FreshnessShape): RawBuilder<FreshnessRow> {
	const storeFilter = shape.stores.length === 0
		? sql``
		: sql`AND (${shape.merchantId}, ${shape.marketplaceId}) IN (${
			sql.join(shape.stores.map((store) => sql`(${store.merchantId}, ${store.marketplaceId})`))
		})`;
	const extraWhere = shape.extraWhere ?? sql``;

	return sql<FreshnessRow>`
		WITH present AS (
			SELECT ${shape.merchantId} AS "merchantId",
			       ${shape.marketplaceId} AS "marketplaceId",
			       ${shape.date} AS "date",
			       ${shape.signal} AS "signal"
			FROM ${shape.relation}
			WHERE ${shape.date} >= CURRENT_DATE - ${FRESHNESS_RULE.scanDays}::int
			${extraWhere}
			${storeFilter}
			GROUP BY 1, 2, 3
		),
		ranked AS (
			SELECT "merchantId", "marketplaceId", "date", "signal",
			       ROW_NUMBER() OVER (
			           PARTITION BY "merchantId", "marketplaceId" ORDER BY "date" DESC
			       ) AS "recency"
			FROM present
		),
		baseline AS (
			SELECT "merchantId", "marketplaceId",
			       percentile_cont(0.5) WITHIN GROUP (ORDER BY "signal") AS "baselineSignal"
			FROM ranked
			WHERE "recency" <= ${FRESHNESS_RULE.baselineDays}::int
			GROUP BY 1, 2
		)
		SELECT r."merchantId",
		       r."marketplaceId",
		       MAX(r."date")::text AS "maxPresentDate",
		       MAX(r."date") FILTER (
		           WHERE r."signal" >= b."baselineSignal" * ${FRESHNESS_RULE.fraction}::float8
		       )::text AS "maxDefinitiveDate",
		       MAX(b."baselineSignal")::float8 AS "baselineSignal"
		FROM ranked r
		JOIN baseline b
		  ON b."merchantId" = r."merchantId" AND b."marketplaceId" = r."marketplaceId"
		GROUP BY 1, 2
	`;
}

/** Run a freshness query and fold the rows into a {@link SourceFreshness}. */
export async function readFreshness(
	db: Kysely<DB>,
	runner: CanonicalQueryRunner,
	params: {
		readonly source: string;
		readonly relation: string;
		readonly rule: string;
		readonly query: RawBuilder<FreshnessRow>;
	},
): Promise<SourceFreshness> {
	const rows = await executeCompiled(runner, params.query.compile(db));
	const perStore: readonly StoreFreshness[] = rows.map((row) => ({
		merchantId: row.merchantId,
		marketplaceId: row.marketplaceId,
		maxPresentDate: row.maxPresentDate,
		maxDefinitiveDate: row.maxDefinitiveDate,
		baselineSignal: row.baselineSignal,
	}));
	const definitive = perStore
		.map((store) => store.maxDefinitiveDate)
		.filter((date): date is string => date !== null)
		.sort();
	return {
		source: params.source,
		relation: params.relation,
		rule: params.rule,
		perStore,
		anchorDate: definitive[0] ?? null,
	};
}
