/** Compiled-SQL rules for the canonical AmazonOrders reader. No database. */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { AMAZON_ORDERS } from "../../src/canonical/amazonOrders/declaration.ts";
import { compileOrdersLevelQuery, type OrdersLevelQueryParams } from "../../src/canonical/amazonOrders/read.ts";
import { keyColumnsForMeasures, measuresForLevel } from "../../src/canonical/declaration.ts";
import { createCanonicalQueryBuilder } from "../../src/canonical/execute.ts";
import { ordersFreshnessQuery } from "../../src/canonical/freshness.ts";

const db = createCanonicalQueryBuilder();
const WINDOW = { dateFirst: "2026-08-01", dateLast: "2026-08-14" } as const;

function paramsFor(
	level: Parameters<typeof measuresForLevel>[1],
	overrides: Partial<OrdersLevelQueryParams> = {},
): OrdersLevelQueryParams {
	const spec = AMAZON_ORDERS.levels.find((entry) => entry.level === level);
	assert(spec !== undefined, `no declared level ${level}`);
	const measures = measuresForLevel(AMAZON_ORDERS, level);
	return {
		request: { level, timeGranularity: "DAY", window: { kind: "explicit", ...WINDOW } },
		keyColumns: keyColumnsForMeasures(spec, measures),
		stores: [],
		window: WINDOW,
		measures,
		...overrides,
	};
}

Deno.test("AmazonOrders compile - settled line predicate and default Non-Amazon exclusion", () => {
	const compiled = compileOrdersLevelQuery(db, paramsFor("SKU"));
	assertStringIncludes(compiled.sql, `COALESCE("o"."order_status", '') <> 'Cancelled'`);
	assertStringIncludes(compiled.sql, `COALESCE("o"."item_status", '') <> 'Cancelled'`);
	assertStringIncludes(compiled.sql, `"o"."asin" is not null`);
	assertStringIncludes(compiled.sql, `COALESCE("o"."sales_channel", '') NOT LIKE 'Non-Amazon%'`);
	assertStringIncludes(compiled.sql, `SUM("o"."quantity")`);
	assert(!compiled.sql.includes("quantity_shipped"));
	assert(!compiled.sql.includes("quantity_unshipped"));

	const included = compileOrdersLevelQuery(
		db,
		paramsFor("SKU", {
			request: {
				level: "SKU",
				timeGranularity: "DAY",
				window: { kind: "explicit", ...WINDOW },
				includeNonAmazonSalesChannels: true,
			},
		}),
	);
	assert(!included.sql.includes("Non-Amazon%"));
});

Deno.test("AmazonOrders compile - parent ASIN maps through marketplace code", () => {
	const parent = compileOrdersLevelQuery(db, paramsFor("PARENT_ASIN"));
	assertStringIncludes(parent.sql, `inner join "amazon_marketplace" as "m"`);
	assertStringIncludes(parent.sql, `left join "amzspapi_catalog_items_v20220401__catalogitem" as "c"`);
	assertStringIncludes(parent.sql, `"c"."marketplace_code" = "m"."marketplace_code"`);
	assertStringIncludes(parent.sql, `COALESCE(NULLIF("c"."parent_asin", ''), "o"."asin")`);
	assertStringIncludes(parent.sql, `as "marketplaceId"`);
	assertStringIncludes(parent.sql, `as "parentAsin"`);

	const asin = compileOrdersLevelQuery(db, paramsFor("ASIN"));
	assert(!asin.sql.includes("amzspapi_catalog_items_v20220401__catalogitem"));
	assert(!asin.sql.includes(`as "marketplaceId"`));
});

Deno.test("AmazonOrders compile - distinct order count is recomputed at the requested grouping", () => {
	for (const level of ["SUM", "STORE", "ASIN", "SKU"] as const) {
		const compiled = compileOrdersLevelQuery(db, paramsFor(level));
		assertStringIncludes(
			compiled.sql,
			`COUNT(DISTINCT ("o"."merchant_id", "o"."amazon_order_id"))::float8 as "orders"`,
		);
	}
});

Deno.test("AmazonOrders compile - daily ECB conversion prefers previous then future", () => {
	const compiled = compileOrdersLevelQuery(
		db,
		paramsFor("SUM", {
			request: {
				level: "SUM",
				timeGranularity: "DAY",
				window: { kind: "explicit", ...WINDOW },
				targetCurrency: "GBP",
			},
		}),
	);
	assertStringIncludes(compiled.sql, `left join lateral`);
	assertStringIncludes(compiled.sql, `"fromFxRows"."timeFormat" = `);
	assertStringIncludes(compiled.sql, `"fromFxRows"."period" <= "o"."localdate"::text`);
	assertStringIncludes(compiled.sql, `"fromFxRows"."period" END desc`);
	assertStringIncludes(compiled.sql, `"fromFxRows"."period" END asc`);
	assertStringIncludes(compiled.sql, `ELSE COALESCE("o"."currency", "m"."currency")`);
	assertStringIncludes(compiled.sql, `THEN 1::numeric ELSE "fromFx"."value"::numeric END`);
	assertStringIncludes(compiled.sql, `THEN 1::numeric ELSE "toFx"."value"::numeric END`);
	assert(compiled.parameters.includes("P1D"));
	assert(compiled.parameters.includes("GBP"));
	for (const column of ["extendedPrice", "extendedPriceExclTax", "itemTaxAmount", "shippingAmount"]) {
		assertStringIncludes(compiled.sql, `as "${column}"`);
	}
});

Deno.test("AmazonOrders compile - currency is a key only for money projections", () => {
	const spec = AMAZON_ORDERS.levels.find((entry) => entry.level === "ASIN");
	assert(spec !== undefined);
	const offered = measuresForLevel(AMAZON_ORDERS, "ASIN");
	const units = offered.filter((measure) => measure.name === "units");
	const money = offered.filter((measure) => measure.name === "extendedPrice");

	const unitsOnly = compileOrdersLevelQuery(
		db,
		paramsFor("ASIN", {
			keyColumns: keyColumnsForMeasures(spec, units),
			measures: units,
		}),
	);
	assertEquals(unitsOnly.sql.includes(`as "currency"`), false);

	const withMoney = compileOrdersLevelQuery(
		db,
		paramsFor("ASIN", {
			keyColumns: keyColumnsForMeasures(spec, money),
			measures: money,
		}),
	);
	assertStringIncludes(withMoney.sql, `as "currency"`);
});

Deno.test("AmazonOrders compile - freshness caps the latest observed date after local midnight", () => {
	const compiled = ordersFreshnessQuery([{ merchantId: "M1", marketplaceId: "MP1" }]).compile(db);
	assertStringIncludes(compiled.sql, `LEAST(`);
	assertStringIncludes(compiled.sql, `CURRENT_TIMESTAMP AT TIME ZONE COALESCE("m"."time_zone", 'UTC')`);
	assertStringIncludes(compiled.sql, `JOIN "amazon_store" s`);
	assertStringIncludes(compiled.sql, `"s"."isReal" = TRUE`);
	assertStringIncludes(compiled.sql, `INTERVAL '1 hour'`);
	assertStringIncludes(compiled.sql, `::date - 1`);
	assertEquals(compiled.parameters, [2, 90, "M1", "MP1"]);
});

Deno.test("AmazonOrders compile - every caller value is bound", () => {
	const compiled = compileOrdersLevelQuery(
		db,
		paramsFor("FAMILY", {
			request: {
				level: "FAMILY",
				timeGranularity: "DAY",
				window: { kind: "explicit", ...WINDOW },
				countryCodes: ["DE'; DROP TABLE x; --"],
				families: ["widgets'; DROP TABLE y; --"],
				targetCurrency: "EUR",
			},
			stores: [{ merchantId: "M-1", marketplaceId: "MP-1" }],
		}),
	);
	assert(compiled.parameters.includes("DE'; DROP TABLE x; --"));
	assert(compiled.parameters.includes("widgets'; DROP TABLE y; --"));
	assert(compiled.parameters.includes("M-1"));
	assert(!compiled.sql.includes("DROP TABLE"));
});
