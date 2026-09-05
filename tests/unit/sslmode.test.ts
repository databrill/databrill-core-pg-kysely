/**
 * Unit tests for `sslmode` handling: the mode → `ssl` mapping and the
 * connection-string rewrite that makes it stick.
 *
 * Nothing here touches a driver or a socket. `sslmode.ts` imports nothing at
 * runtime, and these tests are the reason it can stay that way — the wiring
 * assertion that `createDb()` hands the result to the pool lives in
 * `createDb.test.ts`, and the round trip against real Postgres in
 * `tests/integration/`.
 *
 * Public-safe: this file syncs to the public mirror.
 */

import { assert, assertEquals, assertStrictEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.19";
import { type ResolvedTlsConfig, resolveSslMode, tlsConfigForSslMode } from "../../src/sslmode.ts";

Deno.test("tlsConfigForSslMode - each mode carries libpq's meaning, not pg's", () => {
	const table: readonly (readonly [string, boolean | ResolvedTlsConfig])[] = [
		["verify-full", { rejectUnauthorized: true }],
		// The row the whole feature exists for, and the one assertion here whose
		// inversion is the original defect: `pg` 8.16+ treats `require` as an
		// alias for `verify-full`, and the Supabase pooler then fails the connection
		// with `self-signed certificate in certificate chain`. libpq's `require`
		// means encrypted, not verified.
		["require", { rejectUnauthorized: false }],
		["prefer", { rejectUnauthorized: false }],
		// `allow` is why the mapping is hand-rolled rather than delegated to
		// `pg-connection-string`'s `uselibpqcompat=true`: that switch does not
		// cover `allow` and falls through to verify-full, the opposite of libpq.
		["allow", { rejectUnauthorized: false }],
		["disable", false],
	];
	for (const [mode, expected] of table) {
		assertEquals(tlsConfigForSslMode(mode, undefined), expected, `sslmode=${mode}`);
	}
});

Deno.test("tlsConfigForSslMode - verify-ca with a CA verifies the chain and skips the hostname", () => {
	const config = tlsConfigForSslMode("verify-ca", "PEM");
	// Narrowing off `boolean`, not decoration: the return type is
	// `boolean | ResolvedTlsConfig` and this package permits exactly one type
	// assertion, in `createDb.ts`, which is not this one.
	assert(typeof config === "object", "verify-ca with a CA must return a config, not a boolean");
	assertEquals(config.rejectUnauthorized, true);
	// Field by field because `assertEquals` compares functions by reference, so a
	// whole-object comparison against a fresh arrow function can never pass.
	// A `checkServerIdentity` returning `undefined` is how node:tls is told the
	// hostname checked out. Presence is asserted BEFORE the call: `undefined?.()`
	// is itself `undefined`, so calling through an optional chain would pass just
	// as well with the function gone — and gone is exactly `verify-full`, the mode
	// this one deliberately is not.
	assert(
		typeof config.checkServerIdentity === "function",
		"verify-ca must skip the hostname check, or it is verify-full under another name",
	);
	assertEquals(config.checkServerIdentity(), undefined);
	// Per decision 3: the caller's CA is deliberately NOT copied into the result.
	assertEquals(config.ca, undefined);
});

Deno.test("tlsConfigForSslMode - verify-ca without a CA refuses rather than trusting the public root store", () => {
	// Verifying `verify-ca` against the public root store would accept any
	// publicly-trusted certificate for any hostname, so this refuses instead of
	// silently doing something weaker than asked. This package reads no
	// `sslrootcert=` file, so the only source of a CA is the caller's `ssl`.
	assertThrows(
		() => tlsConfigForSslMode("verify-ca", undefined),
		Error,
		"needs a certificate authority",
	);
});

Deno.test("sslmode - an unrecognised, miscased or empty mode throws and the message names the valid modes", () => {
	// The naming is the assertion, not merely that it threw: the failure this
	// pins is a typo'd mode silently meaning something. Case sensitivity is
	// deliberate and matches `pg-connection-string`'s own switch, so `Require` is
	// a typo rather than a synonym.
	for (const mode of ["insecure", "Require"]) {
		const error = assertThrows(
			() => tlsConfigForSslMode(mode, undefined),
			Error,
			`Invalid sslmode ${JSON.stringify(mode)}`,
		);
		assertStringIncludes(error.message, "expected one of disable, allow, prefer, require, verify-ca, verify-full");
	}
	// An empty value is "anything else" in the table, and it reaches the same
	// refusal through `resolveSslMode` — `sslmode=` is not read as "unset".
	assertThrows(() => resolveSslMode("postgres://h/db?sslmode=", undefined), Error, 'Invalid sslmode ""');
});

Deno.test("resolveSslMode - a mode is mapped and sslmode is removed from the string", () => {
	// The removal is not cosmetic. `pg` merges the parsed connection string OVER
	// the config it was handed, and `pg-connection-string` writes `config.ssl = {}`
	// whenever the string mentions TLS at all — so leaving `sslmode=` in place
	// makes the whole feature a no-op.
	assertEquals(resolveSslMode("postgres://u:p@h:6543/db?pgbouncer=true&sslmode=require", undefined), {
		connectionString: "postgres://u:p@h:6543/db?pgbouncer=true",
		ssl: { rejectUnauthorized: false },
	});
	// Both schemes `parseConnectionUri` accepts are covered: `postgres://` above,
	// `postgresql://` here.
	assertEquals(resolveSslMode("postgresql://h/db?sslmode=verify-full", undefined), {
		connectionString: "postgresql://h/db",
		ssl: { rejectUnauthorized: true },
	});
});

Deno.test("resolveSslMode - a query that held nothing but sslmode leaves no trailing ?", () => {
	assertEquals(resolveSslMode("postgres://h/db?sslmode=disable", undefined), {
		connectionString: "postgres://h/db",
		ssl: false,
	});
});

Deno.test("resolveSslMode - an explicit ssl wins over the string and comes back untouched", () => {
	// The stripping is what makes the precedence real: without it `pg` re-applies
	// its own reading of the string over the caller's `ssl`, and the CA is
	// silently discarded. That is the unfixed bug this change fixes, so both halves
	// are asserted — the caller's object AND the stripped string.
	const callerSsl = { ca: "PEM" };
	const resolved = resolveSslMode("postgres://h/db?sslmode=verify-full", callerSsl);
	assertEquals(resolved.connectionString, "postgres://h/db");
	// The contract is "handed back", not "reconstructed".
	assertStrictEquals(resolved.ssl, callerSsl);
});

Deno.test("resolveSslMode - an explicit ssl of false or true also wins over the string", () => {
	// `false` is the value a truthiness check would mishandle, and the code tests
	// `callerSsl !== undefined` precisely so that "no TLS, I mean it" survives a
	// `sslmode=require` left in a copied connection string.
	assertEquals(resolveSslMode("postgres://h/db?sslmode=require", false), {
		connectionString: "postgres://h/db",
		ssl: false,
	});
	assertEquals(resolveSslMode("postgres://h/db?sslmode=require", true), {
		connectionString: "postgres://h/db",
		ssl: true,
	});
});

Deno.test("resolveSslMode - with an explicit ssl an unrecognised mode does not throw", () => {
	// Deliberate, and the counterpart to the throw above: when the caller has
	// decided, the mode is never consulted, so it is never validated either.
	assertEquals(resolveSslMode("postgres://h/db?sslmode=nonsense", { ca: "PEM" }), {
		connectionString: "postgres://h/db",
		ssl: { ca: "PEM" },
	});
});

Deno.test("resolveSslMode - no sslmode leaves the string byte-identical and sets no ssl", () => {
	const input = "postgres://h/db?application_name=x";
	const resolved = resolveSslMode(input, undefined);
	// Byte-identity, not merely equality: a re-serialised string would satisfy a
	// looser check while breaking the textual preservation this module promises.
	assertStrictEquals(resolved.connectionString, input);
	// `undefined` rather than some object is what keeps `PGSSLMODE` working —
	// `pg` reads it from the environment only while `ssl` is unset.
	assertEquals(resolved.ssl, undefined);
});

Deno.test("resolveSslMode - a libpq key/value DSN is left entirely alone", () => {
	// Its `sslmode=` is deliberately not consumed: a key/value string does not
	// parse as a `URL`, and `pg` handles that form itself.
	const input = "host=h port=5432 sslmode=require user=u";
	const resolved = resolveSslMode(input, undefined);
	assertStrictEquals(resolved.connectionString, input);
	assertEquals(resolved.ssl, undefined);
});

Deno.test("resolveSslMode - a unix-socket path is left entirely alone", () => {
	// The leading-`/` early return exists for this form.
	const input = "/var/run/postgresql";
	const resolved = resolveSslMode(input, undefined);
	assertStrictEquals(resolved.connectionString, input);
	assertEquals(resolved.ssl, undefined);
});

Deno.test("resolveSslMode - a non-postgres scheme is left alone", () => {
	const input = "mysql://h/db?sslmode=require";
	const resolved = resolveSslMode(input, undefined);
	assertStrictEquals(resolved.connectionString, input);
	assertEquals(resolved.ssl, undefined);
});

Deno.test("resolveSslMode - the host-less URI form is handled and the dummy host does not leak", () => {
	// WHATWG `URL` rejects `postgres://user:pass@/db` outright, which libpq and
	// `pg` both accept; `parseConnectionUri` retries with a `@___DUMMY___/`
	// substitution the way `pg-connection-string` does. Without the retry this
	// form reads as "not a URL", keeps its `sslmode`, and gets `pg`'s meanings —
	// the one thing this module exists to stop. That the dummy host stays out of
	// the returned string is the other half of this test.
	assertEquals(resolveSslMode("postgres://user:pass@/db?sslmode=require", undefined), {
		connectionString: "postgres://user:pass@/db",
		ssl: { rejectUnauthorized: false },
	});
});

Deno.test("resolveSslMode - a repeated sslmode takes the last, as pg would", () => {
	// `URLSearchParams.get()` returns the FIRST, so the naive spelling would apply
	// `verify-full` where `pg` — which assigns each entry over the last — applies
	// `disable`. This is the test that catches a refactor to `.get()`. Both
	// occurrences are stripped.
	assertEquals(resolveSslMode("postgres://h/db?sslmode=verify-full&sslmode=disable&a=1", undefined), {
		connectionString: "postgres://h/db?a=1",
		ssl: false,
	});
});

Deno.test("resolveSslMode - uselibpqcompat is stripped alongside sslmode", () => {
	// Leaving it in would ask `pg-connection-string` to apply its own libpq
	// mapping on top of the one this module just applied.
	assertEquals(resolveSslMode("postgres://h/db?uselibpqcompat=true&sslmode=require&a=1", undefined), {
		connectionString: "postgres://h/db?a=1",
		ssl: { rejectUnauthorized: false },
	});
});

Deno.test("resolveSslMode - uselibpqcompat alone is not stripped", () => {
	// The pair with the test above is the statement: the function short-circuits
	// when there is no `sslmode`, so it removes nothing it did not act on.
	const input = "postgres://h/db?uselibpqcompat=true";
	const resolved = resolveSslMode(input, undefined);
	assertStrictEquals(resolved.connectionString, input);
	assertEquals(resolved.ssl, undefined);
});

Deno.test("resolveSslMode - sslcert, sslkey and sslrootcert are left for pg to read", () => {
	// They name files, `pg-connection-string` reads them with `fs`, and this
	// package does no filesystem access — so it does not consume them. Their
	// percent-encoding survives untouched, which is the point of the textual
	// rewrite (see the round-trip test below).
	assertEquals(
		resolveSslMode("postgres://h/db?sslrootcert=%2Fx&sslcert=%2Fc&sslkey=%2Fk&sslmode=prefer", undefined),
		{
			connectionString: "postgres://h/db?sslrootcert=%2Fx&sslcert=%2Fc&sslkey=%2Fk",
			ssl: { rejectUnauthorized: false },
		},
	);
});

Deno.test("resolveSslMode - the sslmode key is case-sensitive too", () => {
	// `URLSearchParams` keys are case-sensitive, so `SSLMODE` is simply not seen:
	// no mapping, no strip, no throw. `pg` would not see it either, so this is
	// consistent rather than merely convenient.
	const input = "postgres://h/db?SSLMODE=require";
	const resolved = resolveSslMode(input, undefined);
	assertStrictEquals(resolved.connectionString, input);
	assertEquals(resolved.ssl, undefined);
});

Deno.test("resolveSslMode - a fragment survives the rewrite", () => {
	assertEquals(resolveSslMode("postgres://h/db?sslmode=require#frag", undefined), {
		connectionString: "postgres://h/db#frag",
		ssl: { rejectUnauthorized: false },
	});
});

Deno.test("resolveSslMode - the surviving query is preserved textually, not re-encoded", () => {
	// `new URL("postgres://h/db?options=-c geqo=off").toString()` yields
	// `?options=-c%20geqo=off`, so this test fails the moment anyone "simplifies"
	// the rewrite into a `URL` round trip. That is exactly why it is here.
	assertEquals(resolveSslMode("postgres://h/db?options=-c geqo=off&sslmode=require", undefined), {
		connectionString: "postgres://h/db?options=-c geqo=off",
		ssl: { rejectUnauthorized: false },
	});
	// A valueless pair has no `=` to split on and must survive as written.
	assertEquals(
		resolveSslMode("postgres://h/db?flag&sslmode=require", undefined).connectionString,
		"postgres://h/db?flag",
	);
});

Deno.test("resolveSslMode - a query key decodes the way URLSearchParams decodes it", () => {
	// `URLSearchParams` decodes `%73slmode` to `sslmode` and therefore FINDS the
	// mode, so the strip has to find the same pair — otherwise a live `sslmode`
	// stays in the string while this module claims to have consumed it.
	assertEquals(resolveSslMode("postgres://h/db?%73slmode=require&a=1", undefined), {
		connectionString: "postgres://h/db?a=1",
		ssl: { rejectUnauthorized: false },
	});
	// `decodeURIComponent("%zz")` throws; a malformed escape must decode to itself
	// instead, because a key this package does not recognise is one it leaves alone.
	assertEquals(resolveSslMode("postgres://h/db?%zz=1&sslmode=require", undefined), {
		connectionString: "postgres://h/db?%zz=1",
		ssl: { rejectUnauthorized: false },
	});
});
