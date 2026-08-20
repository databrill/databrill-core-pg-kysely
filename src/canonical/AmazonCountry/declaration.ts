import type { CanonicalReferenceDeclaration } from "../referenceDeclaration.ts";

/** Countries in which Amazon operates marketplaces. */
export const AMAZON_COUNTRY: CanonicalReferenceDeclaration = {
	name: "AmazonCountry",
	description: "Countries in which Amazon operates marketplaces, with Amazon region and local time zone.",
	grain: ["countryCode"],
	source: {
		relation: "amazon_country",
		whenAbsent: "The Amazon country reference data is not provisioned on this database.",
	},
	fields: [
		{ name: "countryCode", sourceColumn: "country_code", description: "ISO country code.", nullable: false },
		{ name: "countryName", sourceColumn: "country_name", description: "Country display name.", nullable: false },
		{ name: "region", sourceColumn: "region", description: "Amazon region code: NA, EU or FE.", nullable: false },
		{ name: "timeZone", sourceColumn: "time_zone", description: "IANA time zone.", nullable: false },
	],
	filters: [
		{ name: "countryCodes", description: "Restrict to ISO country codes.", required: false },
		{ name: "regions", description: "Restrict to Amazon region codes.", required: false },
	],
};
