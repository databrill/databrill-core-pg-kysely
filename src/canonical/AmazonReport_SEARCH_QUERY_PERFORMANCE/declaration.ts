import type { CanonicalAdditivity, CanonicalDeclaration, CanonicalLevel } from "../declaration.ts";

const SEARCH_QUERY_PERFORMANCE_LEVELS = ["SUM", "STORE", "SEARCH_QUERY"] as const satisfies readonly CanonicalLevel[];

/**
 * A whole-market count is repeated on every ASIN row, and can also repeat for
 * several merchant accounts in one marketplace. It is safe to add only after
 * the reader has normalized those copies to the report's true market grain.
 */
function marketCountAdditivity(): CanonicalAdditivity {
	return {
		kind: "SEMI_ADDITIVE",
		summableAcross: ["DATE", "SEARCH_QUERY"],
		notSummableAcross: ["PRODUCT", "STORE", "MERCHANT"],
		reason: "Amazon repeats the marketplace-wide count on every ASIN row and may repeat it for several " +
			"merchant accounts in one marketplace. Normalize with MAX at (marketplace, report period, search query) " +
			"before adding across periods, search queries, or marketplaces.",
	};
}

/**
 * Canonical declaration for GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT.
 *
 * The source is already aggregated into WEEK or MONTH periods. Those rows must
 * never be treated as daily facts and rebucketed. Its other defining property
 * is the difference between seller counts (`asin*`) and marketplace counts
 * (`total*`): seller counts add across ASIN rows, while marketplace counts are
 * repeated constants that first have to be read once at their true grain.
 */
export const AMAZON_REPORT_SEARCH_QUERY_PERFORMANCE: CanonicalDeclaration = {
	name: "AmazonReport_SEARCH_QUERY_PERFORMANCE",
	description: "Seller and whole-market search-query impressions, clicks, and purchases in the " +
		"GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT. Shares are recomputed from counts after " +
		"normalizing Amazon's repeated market totals.",
	grain: ["merchantId", "marketplaceId", "timeUnit", "dateFirst", "dateLast", "asin", "searchQuery"],

	sources: [{
		role: "FACT",
		key: "report",
		relation: "amzreport_SEARCH_QUERY_PERFORMANCE",
		grain: ["merchantId", "marketplaceId", "timeUnit", "dateFirst", "dateLast", "asin", "searchQuery"],
		serves: SEARCH_QUERY_PERFORMANCE_LEVELS,
		requiredByLevels: SEARCH_QUERY_PERFORMANCE_LEVELS,
		whenAbsent: "The Search Query Performance report is not provisioned on this database.",
	}],

	levels: [
		{
			level: "SUM",
			keyColumns: [],
			source: "report",
			note: "Every selected search query and store together after market-grain normalization.",
		},
		{
			level: "STORE",
			keyColumns: ["merchantId", "marketplaceId"],
			source: "report",
			note: "One seller account in one marketplace. Its market denominator remains marketplace-wide.",
		},
		{
			level: "SEARCH_QUERY",
			keyColumns: ["searchQuery"],
			source: "report",
			note: "One search query across the selected stores and report periods.",
		},
	],

	timeGranularities: ["WEEK", "MONTH", "TOTAL"],

	measures: [
		{
			name: "asinImpressionCount",
			description: "Search-result impressions for the selected seller ASINs.",
			source: "report",
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "totalQueryImpressionCount",
			description: "Whole-market impressions for the search queries represented by the selected ASIN rows.",
			source: "report",
			additivity: marketCountAdditivity(),
		},
		{
			name: "asinImpressionShare",
			description: "Seller ASIN impressions as a percentage of whole-market query impressions.",
			source: "report",
			additivity: {
				kind: "RATIO",
				numerator: "asinImpressionCount",
				denominator: "totalQueryImpressionCount",
				scale: 100,
				reason: "The share must be recomputed from counts at the requested output grain, never averaged.",
			},
		},
		{
			name: "asinClickCount",
			description: "Search-result clicks for the selected seller ASINs.",
			source: "report",
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "totalClickCount",
			description: "Whole-market clicks for the search queries represented by the selected ASIN rows.",
			source: "report",
			additivity: marketCountAdditivity(),
		},
		{
			name: "asinClickShare",
			description: "Seller ASIN clicks as a percentage of whole-market clicks.",
			source: "report",
			additivity: {
				kind: "RATIO",
				numerator: "asinClickCount",
				denominator: "totalClickCount",
				scale: 100,
				reason: "The share must be recomputed from counts at the requested output grain, never averaged.",
			},
		},
		{
			name: "asinPurchaseCount",
			description: "Purchases attributed to the selected seller ASINs from these search queries.",
			source: "report",
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "totalPurchaseCount",
			description: "Whole-market purchases for the search queries represented by the selected ASIN rows.",
			source: "report",
			additivity: marketCountAdditivity(),
		},
		{
			name: "asinPurchaseShare",
			description: "Seller ASIN purchases as a percentage of whole-market purchases.",
			source: "report",
			additivity: {
				kind: "RATIO",
				numerator: "asinPurchaseCount",
				denominator: "totalPurchaseCount",
				scale: 100,
				reason: "The share must be recomputed from counts at the requested output grain, never averaged.",
			},
		},
	],

	filters: [
		{ name: "window", description: "Inclusive date range, or a trailing duration in days.", required: true },
		{
			name: "reportTimeUnit",
			description: "The report's pre-aggregated period type: WEEK or MONTH.",
			required: true,
		},
		{
			name: "stores",
			description: "Exact (merchantId, marketplaceId) pairs. Absent means every store in the report table.",
			required: false,
		},
		{
			name: "asins",
			description: "Restrict seller counts and the surviving search-query set to these ASINs.",
			required: false,
		},
		{
			name: "limit",
			description: "For SEARCH_QUERY/TOTAL only, retain the largest corrected market-impression totals.",
			required: false,
		},
	],

	caveats: [
		{
			code: "SQP_MARKET_TOTALS_REPEAT",
			statement:
				"The total* counts are marketplace-wide constants repeated on ASIN and sometimes merchant rows. " +
				"They are normalized before this reader aggregates them.",
			appliesToLevels: SEARCH_QUERY_PERFORMANCE_LEVELS,
		},
		{
			code: "SQP_PERIODS_ARE_PREAGGREGATED",
			statement: "WEEK and MONTH select different report rows. The reader never rebuckets one into the other.",
			appliesToLevels: SEARCH_QUERY_PERFORMANCE_LEVELS,
		},
	],
};
