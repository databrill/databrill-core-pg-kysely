/** Compiled-SQL rules for the AmazonMarketplace and AmazonCountry readers. No database. */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { compileAmazonCountryQuery } from "../../src/canonical/AmazonCountry/read.ts";
import { compileAmazonMarketplaceQuery } from "../../src/canonical/AmazonMarketplace/read.ts";
import { createCanonicalQueryBuilder } from "../../src/canonical/execute.ts";

const db = createCanonicalQueryBuilder();

Deno.test("AmazonMarketplace compile - aliases source columns to field names and binds every filter value", () => {
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

Deno.test("AmazonCountry compile - reads amazon_country with aliased columns and bound filters", () => {
	const compiled = compileAmazonCountryQuery(db, { countryCodes: ["US"], regions: ["NA"] });
	assertStringIncludes(compiled.sql, `from "amazon_country"`);
	assertStringIncludes(compiled.sql, `"country_name" as "countryName"`);
	assertEquals(compiled.parameters, ["US", "NA"]);
});
