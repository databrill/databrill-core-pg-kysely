import type { CanonicalDeclaration } from "../declaration.ts";

/**
 * `AmazonReport_SALES_AND_TRAFFIC` — sessions, page views and the units that convert from them,
 * everything the SP-API `GET_SALES_AND_TRAFFIC_REPORT` publishes about visits.
 *
 * Single-source in the sense that matters: every number here comes from one
 * report. It arrives in two relations at two grains, and those two DO NOT ADD
 * UP — see `SESSIONS_DO_NOT_RECONCILE` below, which is the most important thing
 * in this file.
 *
 * `orderedProductSales` keeps the report's decimal amount and currency. Its
 * currency becomes an output key only when that measure is selected, so a
 * number-only ASIN request can still aggregate across marketplaces while money
 * can never be added across currencies.
 */
export const AMAZON_REPORT_SALES_AND_TRAFFIC: CanonicalDeclaration = {
	name: "AmazonReport_SALES_AND_TRAFFIC",
	description: "Visits and the resulting sales on a seller's Amazon detail pages and storefront, reported by " +
		"GET_SALES_AND_TRAFFIC_REPORT: sessions, page views, units, ordered-product sales, and the conversion " +
		"rate recomputed at the requested grain.",
	grain: ["merchantId", "marketplaceId", "date", "sku", "currency"],

	sources: [
		{
			role: "FACT",
			key: "skuByDay",
			relation: "amzreport_SALES_AND_TRAFFIC__skuByDay",
			grain: ["merchantId", "marketplaceId", "date", "sku", "currency"],
			serves: ["FAMILY", "PARENT_ASIN", "ASIN", "SKU"],
			requiredByLevels: ["FAMILY", "PARENT_ASIN", "ASIN", "SKU"],
			sourceGrainLevel: "SKU",
			whenAbsent: "The SKU-by-day SALES_AND_TRAFFIC report is not provisioned on this database.",
		},
		{
			role: "FACT",
			key: "store",
			relation: "amzreport_SALES_AND_TRAFFIC__store",
			grain: ["merchantId", "marketplaceId", "dateGranularity", "date", "currency"],
			serves: ["SUM", "MERCHANT", "COUNTRY", "STORE"],
			requiredByLevels: ["SUM", "MERCHANT", "COUNTRY", "STORE"],
			sourceGrainLevel: "STORE",
			whenAbsent: "The storefront-wide report is not present for these stores. Amazon does not publish it " +
				"for every seller, and the levels it serves are omitted rather than filled from the " +
				"SKU-level sum, which would be a number Amazon does not publish and which is knowably " +
				"too high.",
		},
		{
			role: "DIMENSION",
			key: "storeDirectory",
			relation: "amazon_store",
			grain: ["merchantId", "marketplaceId"],
			requiredByLevels: ["SUM", "MERCHANT", "COUNTRY", "STORE", "FAMILY", "PARENT_ASIN", "ASIN", "SKU"],
			whenAbsent: "amazon_store is absent, so a marketplace cannot be resolved to a country and Amazon's " +
				"synthetic storefronts cannot be excluded.",
		},
		{
			role: "DIMENSION",
			key: "familyOntology",
			relation: "brand_config_amazon_asin",
			grain: ["asin"],
			requiredByLevels: ["FAMILY"],
			whenAbsent: "The customer's per-ASIN brand configuration is absent, so no ASIN resolves to a family.",
		},
	],

	// Key columns are the whole parent-ASIN rule, written as data rather than as
	// a comment: PARENT_ASIN carries marketplaceId and ASIN does not.
	levels: [
		{ level: "SUM", keyColumns: [], source: "store", note: "Every requested store together, across merchants." },
		{ level: "MERCHANT", keyColumns: ["merchantId"], source: "store" },
		{
			level: "COUNTRY",
			keyColumns: ["countryCode"],
			source: "store",
			note: "Country of the marketplace, from amazon_store.",
		},
		{ level: "STORE", keyColumns: ["merchantId", "marketplaceId"], source: "store" },
		{
			level: "FAMILY",
			keyColumns: ["family"],
			source: "skuByDay",
			note: "The family is resolved per (ASIN, country) through countryToFamily before grouping, so a " +
				"cross-country roll-up honours a per-country family override. ASINs with no family " +
				"resolve to the (unmapped) bucket rather than disappearing.",
		},
		{
			level: "PARENT_ASIN",
			keyColumns: ["marketplaceId", "parentAsin"],
			source: "skuByDay",
			note: "marketplaceId is in the key whether or not the caller asked for it. Amazon assigns a " +
				"different parent ASIN per marketplace and they are never the same one, so a parent ASIN " +
				"without its marketplace is not an identifier.",
		},
		{
			level: "ASIN",
			keyColumns: ["asin"],
			source: "skuByDay",
			note: "No marketplaceId: the same ASIN is the same product in every marketplace, so an ASIN " +
				"grouping rolls up across them.",
		},
		{ level: "SKU", keyColumns: ["merchantId", "marketplaceId", "sku"], source: "skuByDay" },
	],

	timeGranularities: ["DAY", "WEEK", "MONTH", "TOTAL"],

	measures: [
		{
			name: "sessions",
			description: "Visits to the seller's detail pages, as Amazon counts them.",
			source: "skuByDay",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "sessionsB2B",
			description: "The business-buyer subset of sessions.",
			source: "skuByDay",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "browserSessions",
			description: "Sessions that arrived through a web browser.",
			source: "skuByDay",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "mobileAppSessions",
			description: "Sessions that arrived through the Amazon mobile app.",
			source: "skuByDay",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "pageViews",
			description: "Detail-page views. One session can produce several.",
			source: "skuByDay",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "pageViewsB2B",
			description: "The business-buyer subset of page views.",
			source: "skuByDay",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "unitsOrdered",
			description: "Units ordered. Additive everywhere: a unit is counted once.",
			source: "skuByDay",
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "unitsOrderedB2B",
			description: "The business-buyer subset of units ordered.",
			source: "skuByDay",
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "totalOrderItems",
			description: "Order line items. Additive everywhere.",
			source: "skuByDay",
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "orderedProductSales",
			description: "Ordered-product-sales amount exactly as SALES_AND_TRAFFIC reports it.",
			source: "skuByDay",
			value: { kind: "MONEY", currencyKey: "currency" },
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "unitSessionPercentage",
			description: "Conversion rate: units ordered per session, as a percentage.",
			source: "skuByDay",
			additivity: {
				kind: "RATIO",
				numerator: "unitsOrdered",
				denominator: "sessions",
				scale: 100,
				reason: "A ratio of two measures at different additivity classes. Averaging the source rows' " +
					"values weights a SKU with three sessions the same as one with three thousand.",
			},
		},
		{
			name: "unitSessionPercentageB2B",
			description: "Conversion rate for business buyers.",
			source: "skuByDay",
			additivity: {
				kind: "RATIO",
				numerator: "unitsOrderedB2B",
				denominator: "sessionsB2B",
				scale: 100,
				reason: "Same as unitSessionPercentage, on the B2B numerator and denominator.",
			},
		},
		{
			name: "buyBoxPercentage",
			description: "Share of page views where the seller held the buy box. SKU grain only.",
			source: "skuByDay",
			additivity: {
				kind: "NON_ADDITIVE",
				reason: "Amazon publishes the percentage but not the weights behind it, so it has no defined " +
					"value above the grain it is reported at. Recomputing it would need a page-view- " +
					"weighted average whose weights are not in the data.",
			},
		},
		{
			name: "sessionPercentage",
			description: "Share of the storefront's total sessions. SKU grain only.",
			source: "skuByDay",
			additivity: {
				kind: "NON_ADDITIVE",
				reason: "A share of a total that is not a column at this grain: its denominator is the " +
					"storefront's session count, which comes from the other source entirely. Request the " +
					"STORE level and divide, rather than reading this above SKU grain.",
			},
		},

		{
			name: "sessions",
			description: "Storefront-wide sessions, as Amazon counts them. NOT the sum of the SKU-level ones.",
			source: "store",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "sessionsB2B",
			description: "The business-buyer subset of storefront-wide sessions.",
			source: "store",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "browserSessions",
			description: "Storefront-wide sessions that arrived through a web browser.",
			source: "store",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "mobileAppSessions",
			description: "Storefront-wide sessions that arrived through the Amazon mobile app.",
			source: "store",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "pageViews",
			description: "Storefront-wide page views.",
			source: "store",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "pageViewsB2B",
			description: "The business-buyer subset of storefront-wide page views.",
			source: "store",
			additivity: SESSIONS_ADDITIVITY(),
		},
		{
			name: "unitsOrdered",
			description: "Units ordered across the storefront.",
			source: "store",
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "unitsOrderedB2B",
			description: "The business-buyer subset of units ordered across the storefront.",
			source: "store",
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "totalOrderItems",
			description: "Order line items across the storefront.",
			source: "store",
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "orderedProductSales",
			description: "Storefront ordered-product-sales amount exactly as SALES_AND_TRAFFIC reports it.",
			source: "store",
			value: { kind: "MONEY", currencyKey: "currency" },
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "unitSessionPercentage",
			description: "Storefront conversion rate: units ordered per session, as a percentage.",
			source: "store",
			additivity: {
				kind: "RATIO",
				numerator: "unitsOrdered",
				denominator: "sessions",
				scale: 100,
				reason: "Recomputed at the output grain from the storefront numerator and denominator.",
			},
		},
		{
			name: "buyBoxPercentage",
			description: "Storefront-wide buy-box share. STORE grain only.",
			source: "store",
			additivity: {
				kind: "NON_ADDITIVE",
				reason: "Same as the SKU-grain buy-box share: Amazon publishes the percentage without the " +
					"weights, so it has no defined value above the grain it is reported at.",
			},
		},
	],

	filters: [
		{ name: "window", description: "Inclusive date range, or a trailing duration in days.", required: true },
		{
			name: "stores",
			description: "(merchantId, marketplaceId) pairs. Absent means every real store on the database.",
			required: false,
		},
		{ name: "countryCodes", description: "Restrict to marketplaces in these countries.", required: false },
		{
			name: "asins",
			description: "Restrict to these child ASINs. Not available at the store levels.",
			required: false,
		},
		{
			name: "families",
			description: "Restrict to these product families. Not available at the store levels.",
			required: false,
		},
	],

	caveats: [
		{
			code: "SESSIONS_DO_NOT_RECONCILE",
			statement: "The store levels and the product levels come from different reports and their totals do " +
				"not agree. Sessions are not additive over products — two SKUs of one ASIN share a detail " +
				"page, so summing their sessions counts one visit twice — and every product level above " +
				"SKU is such a sum. A store total is therefore NOT the sum of its ASIN rows, and the ASIN " +
				"rows are the ones that are knowably too high. The store levels read Amazon's own " +
				"storefront-wide count instead, which is the number Amazon publishes.",
			appliesToLevels: ["SUM", "MERCHANT", "COUNTRY", "STORE", "FAMILY", "PARENT_ASIN", "ASIN"],
		},
		{
			code: "PRODUCT_ROLLUP_OVERCOUNTS_SESSIONS",
			statement: "Sessions at FAMILY, PARENT_ASIN and ASIN are summed from SKU rows and therefore double- " +
				"count visitors who viewed more than one SKU of the same product. This matches the " +
				"existing reporting these levels are compared against; it is a known overcount, not an " +
				"estimate. Units, order items and the conversion-rate numerator are unaffected.",
			appliesToLevels: ["FAMILY", "PARENT_ASIN", "ASIN"],
		},
		{
			code: "STORE_LEVELS_SUM_ACROSS_MARKETPLACES",
			statement: "MERCHANT, COUNTRY and SUM add storefront rows across marketplaces. Different " +
				"marketplaces are different storefronts, so a visitor counted in DE and again in FR is " +
				"two visits to two shops rather than one visit counted twice. This is a deliberate " +
				"decision, not an accident of the grouping.",
			appliesToLevels: ["SUM", "MERCHANT", "COUNTRY"],
		},
		{
			code: "WINDOW_ANCHORED_ON_OWN_SOURCE",
			statement: "A trailing window ends at this reader's own last definitive date, never at a shared " +
				"clock or at another table's MAX(date). The report's traffic metrics fill three to four " +
				"days after the report date and the day-after run carries sales with page views of zero, " +
				"so the most recent date present is routinely a near-empty placeholder.",
			appliesToLevels: ["SUM", "MERCHANT", "COUNTRY", "STORE", "FAMILY", "PARENT_ASIN", "ASIN", "SKU"],
		},
		{
			code: "SALES_RETAIN_REPORT_CURRENCY",
			statement: "orderedProductSales is summed in PostgreSQL NUMERIC before the completed result is converted " +
				"to a JavaScript number. Currency is part of the output key whenever that measure is selected, so " +
				"amounts in different currencies are never added.",
			appliesToLevels: ["SUM", "MERCHANT", "COUNTRY", "STORE", "FAMILY", "PARENT_ASIN", "ASIN", "SKU"],
		},
		{
			code: "UNMAPPED_FAMILY_BUCKET",
			statement: "An ASIN the customer has not assigned to a family is reported under the family " +
				"(unmapped) rather than dropped, so a FAMILY roll-up still totals to the same sessions as " +
				"the ASIN level beneath it.",
			appliesToLevels: ["FAMILY"],
		},
	],
};

/**
 * The one additivity classification every session-like measure shares.
 *
 * A function rather than a shared constant so each measure holds its own frozen
 * literal, which keeps a later per-measure amendment from silently editing every
 * other measure that referenced the same object.
 */
function SESSIONS_ADDITIVITY(): {
	readonly kind: "SEMI_ADDITIVE";
	readonly summableAcross: readonly ["DATE", "STORE", "MERCHANT"];
	readonly notSummableAcross: readonly ["PRODUCT"];
	readonly reason: string;
} {
	return {
		kind: "SEMI_ADDITIVE",
		summableAcross: ["DATE", "STORE", "MERCHANT"],
		notSummableAcross: ["PRODUCT"],
		reason: "A visit spans a whole detail page, so sessions add over dates and over storefronts but not " +
			"over the products within one storefront: two SKUs of one ASIN share a page, and summing " +
			"their sessions counts that visit twice.",
	};
}
