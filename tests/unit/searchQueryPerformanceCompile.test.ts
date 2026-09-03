/** Compile-time checks for Search Query Performance's two-stage aggregation. */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.19";
import { keyColumnsForMeasures, measuresForLevel } from "../../src/canonical/declaration.ts";
import { createCanonicalQueryBuilder } from "../../src/canonical/execute.ts";
import { searchQueryPerformanceFreshnessQuery } from "../../src/canonical/freshness.ts";
import { AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE } from "../../src/canonical/AmazonReport_SEARCH_QUERY_PERFORMANCE/declaration.ts";
import {
	type AmazonReportSearchQueryPerformanceLevel,
	compileSearchQueryPerformanceQuery,
	type SearchQueryPerformanceQueryParams,
} from "../../src/canonical/AmazonReport_SEARCH_QUERY_PERFORMANCE/read.ts";

const db = createCanonicalQueryBuilder();
const WINDOW = { dateFirst: "2026-07-01", dateLast: "2026-07-31" } as const;

function paramsFor(
	level: AmazonReportSearchQueryPerformanceLevel,
	overrides: Partial<SearchQueryPerformanceQueryParams> = {},
): SearchQueryPerformanceQueryParams {
	const spec = AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE.levels.find((entry) => entry.level === level);
	assert(spec !== undefined);
	const measures = measuresForLevel(AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE, level);
	return {
		request: {
			level,
			reportTimeUnit: "WEEK",
			timeGranularity: level === "SEARCH_QUERY" ? "TOTAL" : "WEEK",
			window: { kind: "explicit", ...WINDOW },
		},
		keyColumns: keyColumnsForMeasures(spec, measures),
		stores: [],
		window: WINDOW,
		measures,
		...overrides,
	};
}

Deno.test("Search Query Performance compile - normalizes market counts before outer aggregation", () => {
	const compiled = compileSearchQueryPerformanceQuery(db, paramsFor("SUM"));
	assertStringIncludes(
		compiled.sql,
		`MAX(("impressionData"->>'totalQueryImpressionCount')::numeric) AS "totalQueryImpressionCount"`,
	);
	assertStringIncludes(
		compiled.sql,
		`SUM(("impressionData"->>'asinImpressionCount')::numeric) AS "asinImpressionCount"`,
	);
	assertStringIncludes(
		compiled.sql,
		`SUM("n"."totalQueryImpressionCount")::numeric AS "totalQueryImpressionCount"`,
	);
	assertStringIncludes(compiled.sql, `GROUP BY "marketplaceId", "dateFirst", "dateLast", "searchQuery"`);
});

Deno.test("Search Query Performance compile - merchant stays only when STORE is the output level", () => {
	const sum = compileSearchQueryPerformanceQuery(db, paramsFor("SUM"));
	assertEquals(
		sum.sql.includes(`GROUP BY "merchantId", "marketplaceId", "dateFirst", "dateLast", "searchQuery"`),
		false,
	);

	const store = compileSearchQueryPerformanceQuery(db, paramsFor("STORE"));
	assertStringIncludes(
		store.sql,
		`GROUP BY "merchantId", "marketplaceId", "dateFirst", "dateLast", "searchQuery"`,
	);
	assertStringIncludes(store.sql, `"n"."merchantId" AS "merchantId"`);
	assertStringIncludes(store.sql, `"n"."marketplaceId" AS "marketplaceId"`);
});

Deno.test("Search Query Performance compile - WEEK and MONTH select source rows instead of rebucketing", () => {
	const monthParams = paramsFor("SUM", {
		request: {
			level: "SUM",
			reportTimeUnit: "MONTH",
			timeGranularity: "MONTH",
			window: { kind: "explicit", ...WINDOW },
		},
	});
	const month = compileSearchQueryPerformanceQuery(db, monthParams);
	assertStringIncludes(month.sql, `WHERE "timeUnit" = `);
	assert(month.parameters.includes("MONTH"));
	assertEquals(month.sql.includes("date_trunc"), false);

	assertThrows(
		() =>
			compileSearchQueryPerformanceQuery(db, {
				...monthParams,
				request: { ...monthParams.request, timeGranularity: "WEEK" },
			}),
		Error,
		"cannot rebucket MONTH rows as WEEK",
	);
});

Deno.test("Search Query Performance compile - shares are recomputed and never read from report percentages", () => {
	const compiled = compileSearchQueryPerformanceQuery(db, paramsFor("SEARCH_QUERY"));
	assertEquals(compiled.sql.includes(`->>'asinImpressionShare'`), false);
	assertEquals(compiled.sql.includes(`->>'asinClickShare'`), false);
	assertEquals(compiled.sql.includes(`->>'asinPurchaseShare'`), false);
	assertStringIncludes(compiled.sql, `AS "asinImpressionCount"`);
	assertStringIncludes(compiled.sql, `AS "totalQueryImpressionCount"`);
});

Deno.test("Search Query Performance compile - returns only the selected count measures", () => {
	const base = paramsFor("SUM");
	const selected = AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE.measures.filter((measure) =>
		measure.name === "asinImpressionCount"
	);
	const compiled = compileSearchQueryPerformanceQuery(db, { ...base, measures: selected });
	const outerSelect = compiled.sql.slice(compiled.sql.lastIndexOf("SELECT"));
	assertStringIncludes(outerSelect, `AS "asinImpressionCount"`);
	assertEquals(outerSelect.includes(`AS "totalQueryImpressionCount"`), false);
	assertEquals(outerSelect.includes(`AS "asinClickCount"`), false);
});

Deno.test("Search Query Performance compile - corrected market impressions determine a limited keyword ranking", () => {
	const base = paramsFor("SEARCH_QUERY");
	const compiled = compileSearchQueryPerformanceQuery(db, {
		...base,
		request: { ...base.request, limit: 25 },
	});
	assertStringIncludes(compiled.sql, `ORDER BY SUM("n"."totalQueryImpressionCount") DESC NULLS LAST`);
	assertStringIncludes(compiled.sql, "LIMIT");
	assertEquals(compiled.parameters.at(-1), 25);

	assertThrows(
		() => {
			const sum = paramsFor("SUM");
			compileSearchQueryPerformanceQuery(db, { ...sum, request: { ...sum.request, limit: 1 } });
		},
		Error,
		"limit is valid only for SEARCH_QUERY/TOTAL",
	);
});

Deno.test("Search Query Performance freshness - pins report time unit and exact store tuples", () => {
	const compiled = searchQueryPerformanceFreshnessQuery([
		{ merchantId: "M-1", marketplaceId: "MP-1" },
		{ merchantId: "M-2", marketplaceId: "MP-1" },
	], "WEEK").compile(db);
	assertStringIncludes(compiled.sql, `MAX("dateLast")::text AS "maxPresentDate"`);
	assertStringIncludes(compiled.sql, `MAX("dateLast")::text AS "maxDefinitiveDate"`);
	assertStringIncludes(compiled.sql, `("merchantId", "marketplaceId") IN`);
	assertEquals(compiled.parameters, ["WEEK", "M-1", "MP-1", "M-2", "MP-1"]);
});

Deno.test("Search Query Performance compile - every caller filter remains a bind parameter", () => {
	const base = paramsFor("SUM");
	const injected = "B0BAD'; DROP TABLE x; --";
	const compiled = compileSearchQueryPerformanceQuery(db, {
		...base,
		stores: [{ merchantId: "M-1", marketplaceId: "MP-1" }],
		request: {
			...base.request,
			stores: [{ merchantId: "M-1", marketplaceId: "MP-1" }],
			asins: [injected],
		},
	});
	assert(compiled.parameters.includes("M-1"));
	assert(compiled.parameters.includes("MP-1"));
	assert(compiled.parameters.includes(injected));
	assertStringIncludes(compiled.sql, `("merchantId", "marketplaceId") IN`);
	assertEquals(compiled.sql.includes("DROP TABLE"), false);
});
