/** Compiled contracts for AmazonMarketplace and AmazonCountry. */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { AMAZON_COUNTRY } from "../../src/canonical/AmazonCountry/declaration.ts";
import { compileAmazonCountryQuery } from "../../src/canonical/AmazonCountry/read.ts";
import { AMAZON_MARKETPLACE } from "../../src/canonical/AmazonMarketplace/declaration.ts";
import { compileAmazonMarketplaceQuery } from "../../src/canonical/AmazonMarketplace/read.ts";
import { createCanonicalQueryBuilder } from "../../src/canonical/execute.ts";

const db = createCanonicalQueryBuilder();

Deno.test("AmazonMarketplace declaration and compile - maps identifiers without conflating them", () => {
	assertEquals(AMAZON_MARKETPLACE.grain, ["marketplaceId"]);
	assertEquals(AMAZON_MARKETPLACE.fields.map((field) => [field.name, field.sourceColumn]), [
		["marketplaceId", "marketplace_id"],
		["marketplaceCode", "marketplace_code"],
		["name", "name"],
		["countryCode", "country_code"],
		["currency", "currency"],
		["languageCode", "lang"],
		["domain", "domain"],
		["timeZone", "time_zone"],
	]);
	const compiled = compileAmazonMarketplaceQuery(db, {
		marketplaceIds: ["MP'; DROP TABLE x; --"],
		marketplaceCodes: ["DE"],
		countryCodes: ["DE"],
	});
	assertStringIncludes(compiled.sql, `"marketplace_id" as "marketplaceId"`);
	assertStringIncludes(compiled.sql, `"marketplace_code" as "marketplaceCode"`);
	assert(compiled.parameters.includes("MP'; DROP TABLE x; --"));
	assert(!compiled.sql.includes("DROP TABLE"));
});

Deno.test("AmazonCountry declaration and compile - exposes country, region and time zone", () => {
	assertEquals(AMAZON_COUNTRY.grain, ["countryCode"]);
	assertEquals(AMAZON_COUNTRY.fields.map((field) => field.name), [
		"countryCode",
		"countryName",
		"region",
		"timeZone",
	]);
	const compiled = compileAmazonCountryQuery(db, { countryCodes: ["US"], regions: ["NA"] });
	assertStringIncludes(compiled.sql, `from "amazon_country"`);
	assertStringIncludes(compiled.sql, `"country_name" as "countryName"`);
	assertEquals(compiled.parameters, ["US", "NA"]);
});
