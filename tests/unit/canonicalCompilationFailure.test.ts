import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1.0.19";
import { Either } from "effect";
import { compileAmazonCountryQuery } from "../../src/canonical/AmazonCountry/read.ts";
import { compileAmazonMarketplaceQuery } from "../../src/canonical/AmazonMarketplace/read.ts";
import { createCanonicalQueryBuilder } from "../../src/canonical/execute.ts";

Deno.test("canonical public compilers synchronously capture Kysely plugin exceptions with original cause identity", () => {
	const originalCause = { reason: "external plugin refused the query" };
	const failure = new Error("plugin compilation failed", { cause: originalCause });
	let compilations = 0;
	const db = createCanonicalQueryBuilder().withPlugin({
		transformQuery() {
			compilations++;
			throw failure;
		},
		transformResult(args) {
			return Promise.resolve(args.result);
		},
	});
	const results = [compileAmazonCountryQuery(db), compileAmazonMarketplaceQuery(db)];
	for (const result of results) {
		assert(Either.isLeft(result));
		assertStrictEquals(result.left, failure);
		assertStrictEquals(result.left.cause, originalCause);
	}
	assertEquals(compilations, 2);
});
