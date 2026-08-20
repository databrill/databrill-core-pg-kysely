import type { CanonicalReferenceDeclaration } from "../referenceDeclaration.ts";

/** Amazon marketplace identifiers and locale defaults. */
export const AMAZON_MARKETPLACE: CanonicalReferenceDeclaration = {
	name: "AmazonMarketplace",
	description: "Amazon marketplace identifiers, names, country, currency, language, storefront domain and " +
		"time zone. marketplaceCode is the short code used by catalog relations and is not marketplaceId.",
	grain: ["marketplaceId"],
	source: {
		relation: "amazon_marketplace",
		whenAbsent: "The Amazon marketplace reference data is not provisioned on this database.",
	},
	fields: [
		{
			name: "marketplaceId",
			sourceColumn: "marketplace_id",
			description: "Amazon marketplace id.",
			nullable: false,
		},
		{
			name: "marketplaceCode",
			sourceColumn: "marketplace_code",
			description: "Short marketplace code used by relations such as Catalog Items.",
			nullable: false,
		},
		{ name: "name", sourceColumn: "name", description: "Marketplace display name.", nullable: false },
		{ name: "countryCode", sourceColumn: "country_code", description: "ISO country code.", nullable: false },
		{ name: "currency", sourceColumn: "currency", description: "Default ISO currency.", nullable: false },
		{ name: "languageCode", sourceColumn: "lang", description: "Default language code.", nullable: false },
		{ name: "domain", sourceColumn: "domain", description: "Marketplace storefront domain.", nullable: false },
		{ name: "timeZone", sourceColumn: "time_zone", description: "IANA time zone, when known.", nullable: true },
	],
	filters: [
		{ name: "marketplaceIds", description: "Restrict to Amazon marketplace ids.", required: false },
		{ name: "marketplaceCodes", description: "Restrict to short marketplace codes.", required: false },
		{ name: "countryCodes", description: "Restrict to ISO country codes.", required: false },
	],
};
