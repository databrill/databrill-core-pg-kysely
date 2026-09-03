/**
 * Unit tests for the Temporal conversion layer.
 *
 * This is where the package's only real parsing logic lives, and it is pure, so
 * it is tested here rather than through a database. The cases that matter are
 * the ones where being confidently wrong would be worse than failing: a
 * zone-less timestamp must not acquire an offset, and a value with no Temporal
 * representation must raise rather than land on a nearby instant.
 *
 * Public-safe: this file syncs to the public mirror.
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
	isTemporalValue,
	parseInstant,
	parsePlainDate,
	parsePlainDateTime,
	temporalToPostgres,
	UnrepresentableTemporalValueError,
} from "../../src/temporalValues.ts";

Deno.test("parseInstant - accepts PostgreSQL's default output verbatim", () => {
	// The space separator and the hours-only offset are what Postgres actually
	// emits under `DateStyle = ISO, MDY`; neither is valid ISO-8601, and both
	// are why a normalization step used to look necessary.
	const fromPostgres = parseInstant("2026-08-10 19:18:27.361+00");
	const fromIso = parseInstant("2026-08-10T19:18:27.361+00:00");
	assertEquals(fromPostgres.epochNanoseconds, fromIso.epochNanoseconds);
	assertEquals(fromPostgres.toString(), "2026-08-10T19:18:27.361Z");
});

Deno.test("parseInstant - a non-UTC offset resolves to the instant it names", () => {
	const instant = parseInstant("2026-08-10 19:18:27+05:30");
	assertEquals(instant.toString(), "2026-08-10T13:48:27Z");
});

Deno.test("parseInstant - sub-minute offsets survive", () => {
	// Pre-1900 zones really do carry offset seconds. Truncating would move the
	// instant, so the value must be honoured, not rounded.
	const instant = parseInstant("1883-11-18 12:00:00-00:53:28");
	assertEquals(instant.toString(), "1883-11-18T12:53:28Z");
});

Deno.test("parseInstant - infinity sentinels raise rather than resolving to some instant", () => {
	for (const sentinel of ["infinity", "-infinity"]) {
		const error = assertThrows(
			() => parseInstant(sentinel),
			UnrepresentableTemporalValueError,
		);
		assertEquals(error.rawValue, sentinel);
		// The message has to say what to do, because there is no way for the
		// caller to recover the value from the type otherwise.
		assert(error.message.includes("as text"), `message should name the workaround: ${error.message}`);
	}
});

Deno.test("parseInstant - a BC date raises", () => {
	assertThrows(() => parseInstant("0044-03-15 00:00:00+00 BC"), UnrepresentableTemporalValueError);
});

Deno.test("parseInstant - a zone-less timestamp raises rather than being read as UTC", () => {
	// The single most damaging thing this layer could do is decide that a
	// `timestamp without time zone` means UTC. It must refuse instead.
	assertThrows(() => parseInstant("2026-08-10 19:18:27.361"), UnrepresentableTemporalValueError);
});

Deno.test("parsePlainDateTime - keeps wall-clock time and adds no offset", () => {
	const plain = parsePlainDateTime("2026-08-10 19:18:27.361");
	assertEquals(plain.toString(), "2026-08-10T19:18:27.361");
	assert(!plain.toString().includes("Z"), "a zone-less timestamp must not be labelled UTC");
	assert(!plain.toString().includes("+"), "a zone-less timestamp must not gain an offset");
});

Deno.test("parsePlainDate - a bare calendar day", () => {
	assertEquals(parsePlainDate("2026-08-10").toString(), "2026-08-10");
});

Deno.test("parsePlainDate - rejects a value that is not a date", () => {
	assertThrows(() => parsePlainDate("not-a-date"), UnrepresentableTemporalValueError);
});

Deno.test("isTemporalValue - recognizes Temporal values and nothing else", () => {
	assert(isTemporalValue(Temporal.Instant.from("2026-08-10T00:00:00Z")));
	assert(isTemporalValue(Temporal.PlainDate.from("2026-08-10")));
	assert(isTemporalValue(Temporal.PlainDateTime.from("2026-08-10T00:00:00")));
	assert(isTemporalValue(Temporal.ZonedDateTime.from("2026-08-10T00:00:00[UTC]")));
	assert(isTemporalValue(Temporal.Duration.from("PT1H")));

	// Everything a query parameter might otherwise hold must pass through.
	for (const other of [null, undefined, 1, "2026-08-10T00:00:00Z", true, {}, [], new Date()]) {
		assert(!isTemporalValue(other), `${String(other)} is not a Temporal value`);
	}
});

Deno.test("temporalToPostgres - renders Temporal values to text and leaves the rest alone", () => {
	assertEquals(
		temporalToPostgres(Temporal.Instant.from("2026-08-10T19:18:27.361Z")),
		"2026-08-10T19:18:27.361Z",
	);
	assertEquals(temporalToPostgres(Temporal.PlainDate.from("2026-08-10")), "2026-08-10");

	const date = new Date(0);
	assertEquals(temporalToPostgres(date), date, "a Date must reach pg untouched — pg knows how to serialize it");
	assertEquals(temporalToPostgres(null), null);
	assertEquals(temporalToPostgres("already text"), "already text");
	assertEquals(temporalToPostgres(42), 42);
});

Deno.test("temporalToPostgres - walks arrays, because `= ANY($1)` is one parameter holding many values", () => {
	// `col = ANY($1)` compiles to a single parameter whose value is a JS array —
	// the standard way to avoid an `in` list with thousands of entries. Testing
	// the array object itself for Temporal-ness finds nothing and lets every
	// element through to pg, which JSON-stringifies them into a literal
	// Postgres rejects.
	assertEquals(
		temporalToPostgres([
			Temporal.Instant.from("2026-08-10T00:00:00Z"),
			Temporal.Instant.from("2026-08-11T00:00:00Z"),
		]),
		["2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z"],
	);
	// Mixed and nested arrays are handled, and non-Temporal entries survive.
	assertEquals(
		temporalToPostgres(["plain", Temporal.PlainDate.from("2026-08-10"), 7, null]),
		["plain", "2026-08-10", 7, null],
	);
	assertEquals(
		temporalToPostgres([[Temporal.PlainDate.from("2026-08-10")]]),
		[["2026-08-10"]],
	);
	// An array with nothing to render comes back with the same values.
	assertEquals(temporalToPostgres([1, "two", null]), [1, "two", null]);
});

Deno.test("temporalToPostgres - a ZonedDateTime loses its IANA annotation, which Postgres rejects", () => {
	// Only a raw SQL fragment can smuggle one of these in, where the type
	// checker cannot help. `toString()` yields `...+00:00[UTC]`, and Postgres
	// answers with `22007 invalid input syntax`. The offset alone fixes the
	// instant, so dropping the bracketed name is lossless for the column.
	const zoned = Temporal.ZonedDateTime.from("2026-08-10T19:18:27.361+00:00[UTC]");
	const rendered = temporalToPostgres(zoned);
	assert(typeof rendered === "string");
	assert(!rendered.includes("["), `annotation must be stripped, got ${rendered}`);
	assertEquals(Temporal.Instant.from(rendered).toString(), "2026-08-10T19:18:27.361Z");
});
