/**
 * The canonical layer as a COMPILER: what SQL comes out, and whether the row
 * types the caller gets are the ones the generated schema promises.
 *
 * No database. Every rule asserted here is a property of the compiled text, and
 * the ones that matter are the ones a future edit is most likely to undo
 * silently:
 *
 * - `PARENT_ASIN` carries the marketplace and `ASIN` does not;
 * - the store relation is never read without its `dateGranularity` filter;
 * - the family is resolved through `countryToFamily` before grouping;
 * - a `NON_ADDITIVE` measure never appears above the source grain;
 * - a ratio is never selected from the database, only recomputed.
 *
 * A results-based test would catch some of these and would need a container to
 * do it. These need neither.
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import type { InferResult } from "kysely";
import { createCanonicalQueryBuilder, makePostgresJsTypes } from "../../src/canonical/execute.ts";
import { pgTypeParsers } from "../../src/pgTypeParsers.ts";
import { keyColumnsForMeasures, measuresForLevel } from "../../src/canonical/declaration.ts";
import { AMAZON_REPORT_SALES_AND_TRAFFIC } from "../../src/canonical/AmazonReport_SALES_AND_TRAFFIC/declaration.ts";
import { compileLevelQuery, type LevelQueryParams } from "../../src/canonical/AmazonReport_SALES_AND_TRAFFIC/read.ts";
import { skuByDayFreshnessQuery, storeFreshnessQuery } from "../../src/canonical/freshness.ts";

const db = createCanonicalQueryBuilder();
const WINDOW = { dateFirst: "2026-08-01", dateLast: "2026-08-14" } as const;

function paramsFor(level: Parameters<typeof measuresForLevel>[1], overrides: Partial<LevelQueryParams> = {}) {
	const spec = AMAZON_REPORT_SALES_AND_TRAFFIC.levels.find((entry) => entry.level === level);
	assert(spec !== undefined, `no declared level ${level}`);
	const measures = measuresForLevel(AMAZON_REPORT_SALES_AND_TRAFFIC, level);
	return {
		request: { level, timeGranularity: "DAY", window: { kind: "explicit", ...WINDOW } },
		keyColumns: keyColumnsForMeasures(spec, measures),
		sourceKey: spec.source,
		stores: [],
		window: WINDOW,
		measures,
		...overrides,
	} satisfies LevelQueryParams;
}

Deno.test("canonical - a trivial query's row type comes from the generated schema", () => {
	const query = db
		.selectFrom("amazon_store")
		.select(["merchantId", "marketplaceId", "countryCode"])
		.where("isReal", "=", true);

	// The point of compiling rather than executing: `InferResult` reads the
	// builder, so these rows are typed by `DbTable_amazon_store` even though
	// nothing here can connect. A column renamed in the generated `db.ts` fails
	// this file at `deno check`, not at runtime on a customer database.
	type Row = InferResult<typeof query>[number];
	const typed: Row = { merchantId: "M1", marketplaceId: "MP1", countryCode: "DE" };
	assertEquals(typed.countryCode, "DE");

	const compiled = query.compile();
	assertStringIncludes(compiled.sql, `from "amazon_store"`);
	assertEquals(compiled.parameters, [true]);

	// `InferResult` accepts the compiled query too, which is what lets a reader
	// type its rows after dropping to `{ sql, parameters }`.
	type CompiledRow = InferResult<typeof compiled>[number];
	const fromCompiled: CompiledRow = typed;
	assertEquals(fromCompiled.merchantId, "M1");
});

Deno.test("canonical - postgres.js and pg are configured from the same OID table", () => {
	const postgresJs = makePostgresJsTypes();
	const covered = Object.values(postgresJs).flatMap((handler) => [...handler.from]).sort();
	const pgCovered = Object.keys(pgTypeParsers).map(Number).sort();

	// The failure this prevents is asymmetric and silent: with only the `pg` half
	// configured, the published types are true under `createDb()` and false under
	// a compiled query, and nothing anywhere throws.
	assertEquals(covered, pgCovered);
	for (const handler of Object.values(postgresJs)) {
		for (const oid of handler.from) {
			assertEquals(handler.parse, pgTypeParsers[oid]);
		}
	}

	// Each OID keeps its own `to`, because postgres.js keys the serializer map by
	// `to` while it keys the parser map by `from`.
	assertEquals(Object.values(postgresJs).map((handler) => handler.to).sort(), pgCovered);
});

Deno.test("canonical - PARENT_ASIN carries the marketplace, ASIN does not", () => {
	const parent = compileLevelQuery(db, paramsFor("PARENT_ASIN"));
	assertStringIncludes(parent.sql, `"marketplaceId"`);
	assertStringIncludes(parent.sql, `"parentAsin"`);

	const asin = compileLevelQuery(db, paramsFor("ASIN"));
	assertStringIncludes(asin.sql, `"childAsin"`);
	// Amazon assigns a different parent per marketplace, so a parent ASIN without
	// its marketplace is not an identifier — while the same ASIN IS the same
	// product everywhere and must roll up across marketplaces.
	assertEquals(asin.sql.includes(`as "marketplaceId"`), false);

	// And the levels are not a roll-up chain: each aggregates from the source
	// relation, so neither query reads the other's output.
	assertStringIncludes(parent.sql, `from "amzreport_SALES_AND_TRAFFIC__skuByDay"`);
	assertStringIncludes(asin.sql, `from "amzreport_SALES_AND_TRAFFIC__skuByDay"`);
});

Deno.test("canonical - the store relation is never read without its dateGranularity filter", () => {
	for (const level of ["SUM", "MERCHANT", "COUNTRY", "STORE"] as const) {
		const compiled = compileLevelQuery(db, paramsFor(level));
		assertStringIncludes(compiled.sql, `from "amzreport_SALES_AND_TRAFFIC__store"`);
		assertStringIncludes(compiled.sql, `"dateGranularity" = `);
		assert(
			compiled.parameters.includes("DAY"),
			`level ${level} must bind the DAY granularity: DAY, WEEK and MONTH rows coexist in this table`,
		);
	}
});

Deno.test("canonical - the family is resolved per country before grouping", () => {
	const compiled = compileLevelQuery(db, paramsFor("FAMILY"));
	// `countryToFamily` is a per-country override map, so reading the flat
	// `family` column alone reports the wrong family wherever an override exists.
	assertStringIncludes(compiled.sql, `"countryToFamily"->>"s"."countryCode"`);
	assertStringIncludes(compiled.sql, `'(unmapped)'`);
	// The join is a LEFT join, so an unconfigured ASIN lands in the (unmapped)
	// bucket instead of vanishing from the roll-up.
	assertStringIncludes(compiled.sql, `left join "brand_config_amazon_asin"`);
});

Deno.test("canonical - a non-additive measure appears only at the source grain", () => {
	const skuMeasures = measuresForLevel(AMAZON_REPORT_SALES_AND_TRAFFIC, "SKU").map((measure) => measure.name);
	assert(skuMeasures.includes("buyBoxPercentage"));

	for (const level of ["ASIN", "PARENT_ASIN", "FAMILY"] as const) {
		const names = measuresForLevel(AMAZON_REPORT_SALES_AND_TRAFFIC, level).map((measure) => measure.name);
		assertEquals(names.includes("buyBoxPercentage"), false, `${level} must not offer buyBoxPercentage`);
		assertEquals(names.includes("sessionPercentage"), false, `${level} must not offer sessionPercentage`);
	}

	// And the compiled SQL agrees: nothing selects it above SKU.
	const asin = compileLevelQuery(db, paramsFor("ASIN"));
	assertEquals(asin.sql.includes(`buy_box_percentage`), false);
});

Deno.test("canonical - a ratio is recomputed, never selected", () => {
	const compiled = compileLevelQuery(db, paramsFor("ASIN"));
	// The declaration offers unitSessionPercentage at every level, but the query
	// selects only its numerator and denominator: averaging the source rows'
	// percentages would weight a SKU with three sessions like one with three
	// thousand, and it would look right.
	assertEquals(compiled.sql.includes(`unit_session_percentage`), false);
	assertStringIncludes(compiled.sql, `as "sessions"`);
	assertStringIncludes(compiled.sql, `as "unitsOrdered"`);

	const offered = measuresForLevel(AMAZON_REPORT_SALES_AND_TRAFFIC, "ASIN").map((measure) => measure.name);
	assert(offered.includes("unitSessionPercentage"));
});

Deno.test("canonical - currency is a key only when ordered-product sales is selected", () => {
	const spec = AMAZON_REPORT_SALES_AND_TRAFFIC.levels.find((entry) => entry.level === "ASIN");
	assert(spec !== undefined);
	const offered = measuresForLevel(AMAZON_REPORT_SALES_AND_TRAFFIC, "ASIN");
	const sessions = offered.filter((measure) => measure.name === "sessions");
	const sales = offered.filter((measure) => measure.name === "orderedProductSales");

	const numberOnly = compileLevelQuery(
		db,
		paramsFor("ASIN", {
			keyColumns: keyColumnsForMeasures(spec, sessions),
			measures: sessions,
		}),
	);
	assertEquals(numberOnly.sql.includes(`as "currency"`), false);

	const money = compileLevelQuery(
		db,
		paramsFor("ASIN", {
			keyColumns: keyColumnsForMeasures(spec, sales),
			measures: sales,
		}),
	);
	assertStringIncludes(money.sql, `->'orderedProductSales'->>'currencyCode' as "currency"`);
	assertStringIncludes(money.sql, `::numeric) as "orderedProductSales"`);
});

Deno.test("canonical - every level's key columns reach the compiled SQL", () => {
	for (const spec of AMAZON_REPORT_SALES_AND_TRAFFIC.levels) {
		const compiled = compileLevelQuery(db, paramsFor(spec.level));
		for (const column of spec.keyColumns) {
			assertStringIncludes(compiled.sql, `as "${column}"`);
		}
		assertStringIncludes(compiled.sql, `as "period"`);
	}
});

Deno.test("canonical - freshness measures row count on one source and the metric on the other", () => {
	const skuByDay = skuByDayFreshnessQuery([]).compile(db);
	// One row per SKU per day, so a placeholder day shows up as a collapsed count.
	assertStringIncludes(skuByDay.sql, "COUNT(*)::float8");
	assertStringIncludes(skuByDay.sql, `"maxDefinitiveDate"`);

	const store = storeFreshnessQuery([]).compile(db);
	// Exactly one row per day whatever happens, so a count proves nothing and the
	// signal has to be the metric itself.
	assertEquals(store.sql.includes("COUNT(*)"), false);
	assertStringIncludes(store.sql, `->>'sessions'`);
	assertStringIncludes(store.sql, `"dateGranularity" = 'DAY'`);
});

Deno.test("canonical - every store pair and filter value is a bind parameter", () => {
	const compiled = compileLevelQuery(
		db,
		paramsFor("ASIN", {
			stores: [{ merchantId: "M-1", marketplaceId: "MP-1" }],
			request: {
				level: "ASIN",
				timeGranularity: "DAY",
				window: { kind: "explicit", ...WINDOW },
				asins: ["B0AAAA0001'; DROP TABLE x; --"],
			},
		}),
	);
	assert(compiled.parameters.includes("M-1"));
	assert(compiled.parameters.includes("B0AAAA0001'; DROP TABLE x; --"));
	assertEquals(compiled.sql.includes("DROP TABLE"), false);
});
