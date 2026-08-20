import type { CanonicalDeclaration, CanonicalLevel } from "../declaration.ts";

const ORDER_LEVELS: readonly CanonicalLevel[] = [
	"SUM",
	"MERCHANT",
	"COUNTRY",
	"STORE",
	"FAMILY",
	"PARENT_ASIN",
	"ASIN",
	"SKU",
];

/**
 * `AmazonOrders` — order lines, units, distinct orders and order money from the
 * hourly GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL report.
 */
const AMAZON_ORDERS: CanonicalDeclaration = {
	name: "AmazonOrders",
	description: "Amazon order lines from the hourly all-orders report, excluding cancelled orders, " +
		"cancelled lines, missing ASINs and Non-Amazon sales channels by default. Money may be converted " +
		"per order date and every returned row states the currency its amounts are actually in.",
	grain: ["merchantId", "marketplaceId", "date", "amazonOrderId", "sku", "currency"],

	sources: [
		{
			role: "FACT",
			key: "orders",
			relation: "amzreport_ALL_ORDERS",
			grain: ["merchantId", "marketplaceId", "date", "amazonOrderId", "sku"],
			serves: ORDER_LEVELS,
			requiredByLevels: ORDER_LEVELS,
			whenAbsent: "The hourly all-orders report has not been provisioned on this database.",
		},
		{
			role: "DIMENSION",
			key: "storeDirectory",
			relation: "amazon_store",
			grain: ["merchantId", "marketplaceId"],
			requiredByLevels: ORDER_LEVELS,
			whenAbsent: "amazon_store is absent, so real seller storefronts cannot be distinguished from " +
				"Amazon's synthetic storefronts.",
		},
		{
			role: "DIMENSION",
			key: "marketplaceDirectory",
			relation: "amazon_marketplace",
			grain: ["marketplaceId"],
			requiredByLevels: ORDER_LEVELS,
			whenAbsent: "amazon_marketplace is absent, so marketplace ids cannot be mapped to country, " +
				"native currency, marketplace code or local time zone.",
		},
		{
			role: "DIMENSION",
			key: "fxRates",
			relation: "fx_ecb_rate_history",
			grain: ["currency", "timeFormat", "period"],
			requiredByLevels: ORDER_LEVELS,
			whenAbsent: "Daily ECB rates are absent, so the reader cannot honour its per-date currency " +
				"conversion contract.",
		},
		{
			role: "DIMENSION",
			key: "catalogItems",
			relation: "amzspapi_catalog_items_v20220401__catalogitem",
			grain: ["marketplaceCode", "asin"],
			requiredByLevels: ["PARENT_ASIN"],
			whenAbsent: "The Catalog Items 2022-04-01 snapshot is absent, so order ASINs cannot be mapped " +
				"to marketplace-specific parent ASINs.",
		},
		{
			role: "DIMENSION",
			key: "familyOntology",
			relation: "brand_config_amazon_asin",
			grain: ["asin"],
			requiredByLevels: ["FAMILY"],
			whenAbsent: "The customer's per-ASIN brand configuration is absent, so order ASINs cannot be " +
				"mapped to product families.",
		},
	],

	levels: [
		{ level: "SUM", keyColumns: [], source: "orders" },
		{ level: "MERCHANT", keyColumns: ["merchantId"], source: "orders" },
		{ level: "COUNTRY", keyColumns: ["countryCode"], source: "orders" },
		{ level: "STORE", keyColumns: ["merchantId", "marketplaceId"], source: "orders" },
		{
			level: "FAMILY",
			keyColumns: ["family"],
			source: "orders",
			note: "Family is resolved per (ASIN, country) through countryToFamily. Unconfigured ASINs use " +
				"the (unmapped) bucket.",
		},
		{
			level: "PARENT_ASIN",
			keyColumns: ["marketplaceId", "parentAsin"],
			source: "orders",
			note: "marketplaceId is always part of the key. The parent comes from the current Catalog Items " +
				"snapshot joined by (amazon_marketplace.marketplace_code, asin); a missing or standalone parent " +
				"uses the child ASIN so unrelated products never collapse into one empty-parent row.",
		},
		{ level: "ASIN", keyColumns: ["asin"], source: "orders" },
		{ level: "SKU", keyColumns: ["merchantId", "marketplaceId", "sku"], source: "orders" },
	],

	timeGranularities: ["DAY", "WEEK", "MONTH", "TOTAL"],

	measures: [
		{
			name: "units",
			description: "Ordered units from quantity. quantity_shipped and quantity_unshipped are transient " +
				"split-shipment fields and are never used.",
			source: "orders",
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "orders",
			description: "Distinct (merchant, Amazon order id) count recomputed at the requested grouping.",
			source: "orders",
			additivity: {
				kind: "SEMI_ADDITIVE",
				summableAcross: ["DATE", "STORE", "MERCHANT"],
				notSummableAcross: ["PRODUCT"],
				reason: "One order can contain several SKUs. Its count is correct in each product row but adding " +
					"those rows counts the order once per product, so the reader recomputes the distinct count at " +
					"every requested grouping.",
			},
		},
		{
			name: "extendedPrice",
			description: "Extended item price from item_price. Its tax convention follows the marketplace: " +
				"tax-exclusive in US/CA and VAT-inclusive in EU marketplaces.",
			source: "orders",
			value: { kind: "MONEY", currencyKey: "currency" },
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "extendedPriceExclTax",
			description: "Tax-exclusive extended item price from vat_exclusive_item_price. Null when any " +
				"contributing order line does not provide the field; missing is not zero.",
			source: "orders",
			value: { kind: "MONEY", currencyKey: "currency" },
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "itemTaxAmount",
			description: "Item tax from item_tax; an absent line value contributes zero.",
			source: "orders",
			value: { kind: "MONEY", currencyKey: "currency" },
			additivity: { kind: "ADDITIVE" },
		},
		{
			name: "shippingAmount",
			description: "Tax-inclusive shipping amount: shipping_price plus shipping_tax.",
			source: "orders",
			value: { kind: "MONEY", currencyKey: "currency" },
			additivity: { kind: "ADDITIVE" },
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
		{ name: "asins", description: "Restrict to these child ASINs.", required: false },
		{ name: "families", description: "Restrict to these product families.", required: false },
		{
			name: "includeNonAmazonSalesChannels",
			description: "Default false. Set true to include sales_channel values beginning with Non-Amazon.",
			required: false,
		},
		{
			name: "targetCurrency",
			description: "ISO 4217 currency requested for money. Absent means each store's native currency. " +
				"Conversion uses the order date's ECB rate, previous date first and future date second.",
			required: false,
		},
	],

	caveats: [
		{
			code: "ALL_ORDERS_RESTATES_HISTORY",
			statement: "ALL_ORDERS is hourly and reflects later cancellations. A past window can therefore " +
				"change and must not be cached as immutable.",
			appliesToLevels: ORDER_LEVELS,
		},
		{
			code: "PARENT_ASIN_IS_CURRENT_CATALOG",
			statement: "Parent ASIN is the current Catalog Items mapping, not a historical mapping as of the " +
				"order date. Missing and standalone mappings use the child ASIN.",
			appliesToLevels: ["PARENT_ASIN"],
		},
		{
			code: "CURRENCY_FALLBACK_PRESERVES_SOURCE",
			statement: "If either side has no ECB rate, the amount remains unchanged under its source currency " +
				"and therefore appears in a different row from successfully converted amounts.",
			appliesToLevels: ORDER_LEVELS,
		},
	],
};

export { AMAZON_ORDERS };
