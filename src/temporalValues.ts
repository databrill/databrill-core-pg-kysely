/**
 * Conversion between PostgreSQL date/time text and Temporal values.
 *
 * The published column types are Temporal objects, so a `timestamptz` column
 * yields a `Temporal.Instant`, a `timestamp` yields a `Temporal.PlainDateTime`,
 * and a `date` yields a `Temporal.PlainDate`. That mapping is not decoration:
 * it is the only one of the three that makes the zone question unambiguous. A
 * `timestamp without time zone` genuinely has no offset, and every
 * string-or-`Date` representation of it either invents one or leaves the caller
 * to remember that it must not.
 *
 * Postgres emits `2026-08-10 19:18:27.361+00` under the default `ISO, MDY`
 * DateStyle. Temporal's parser accepts that verbatim — the space separator and
 * the hours-only offset both — so there is no normalization step here, only
 * parsing and error framing.
 *
 * Runtime requirement: `Temporal` must exist. Newer runtimes have it built in;
 * on one that does not, the caller loads a polyfill
 * (`import "temporal-polyfill/global"`) before connecting. {@link requireTemporal}
 * turns a missing one into a clear error at connection time rather than a
 * `ReferenceError` on the first row read.
 */

/**
 * A Postgres date/time value with no Temporal representation.
 *
 * The two real cases are the `infinity` / `-infinity` sentinels and BC dates.
 * Neither is produced by any column in the published schema, but the database
 * permits them, and silently substituting some nearby instant would be far
 * worse than failing: the caller can always fall back to selecting the column
 * as text.
 */
export class UnrepresentableTemporalValueError extends Error {
	override readonly name = "UnrepresentableTemporalValueError";
	/** The raw text Postgres sent. */
	readonly rawValue: string;

	constructor(rawValue: string, temporalType: string, cause: unknown) {
		super(
			`Cannot represent the PostgreSQL value ${JSON.stringify(rawValue)} as a ${temporalType}. ` +
				`The 'infinity' and '-infinity' sentinels and BC dates have no Temporal equivalent. ` +
				`Select the column as text to read it verbatim.`,
			{ cause },
		);
		this.rawValue = rawValue;
	}
}

/** `timestamptz` — an exact instant. */
export function parseInstant(value: string): Temporal.Instant {
	try {
		return Temporal.Instant.from(value);
	} catch (cause) {
		throw new UnrepresentableTemporalValueError(value, "Temporal.Instant", cause);
	}
}

/** `timestamp without time zone` — a wall-clock reading, deliberately zone-free. */
export function parsePlainDateTime(value: string): Temporal.PlainDateTime {
	try {
		return Temporal.PlainDateTime.from(value);
	} catch (cause) {
		throw new UnrepresentableTemporalValueError(value, "Temporal.PlainDateTime", cause);
	}
}

/** `date` — a calendar day with no time and no zone. */
export function parsePlainDate(value: string): Temporal.PlainDate {
	try {
		return Temporal.PlainDate.from(value);
	} catch (cause) {
		throw new UnrepresentableTemporalValueError(value, "Temporal.PlainDate", cause);
	}
}

/**
 * Is this a Temporal value?
 *
 * Branded via `Object.prototype.toString`, not `instanceof`. Every Temporal
 * type sets `Symbol.toStringTag` to its own name, so this recognizes values
 * from a polyfill, from another realm, and from a future Temporal type this
 * package has never heard of — none of which an `instanceof` chain against the
 * current global would catch.
 */
export function isTemporalValue(value: unknown): boolean {
	return Object.prototype.toString.call(value).startsWith("[object Temporal.");
}

/**
 * Render a Temporal value as the text Postgres expects, leaving anything else
 * untouched. Arrays are walked, so a Temporal value inside one is rendered too.
 *
 * Needed because `pg` has no idea what a Temporal object is: its parameter
 * serializer falls through to `JSON.stringify`, which for a Temporal value
 * produces a QUOTED ISO string (`"2026-08-10T19:18:27.361Z"`, quotes included)
 * that Postgres then rejects. The array case is the same failure one level
 * down: `col = ANY($1)` is a single parameter holding a JS array, and `pg`
 * serializes its elements the same broken way.
 *
 * `toString()` is the right wire form for the types this package publishes, but
 * NOT for every Temporal type. `Temporal.ZonedDateTime` stringifies with a
 * bracketed IANA annotation (`...+02:00[Europe/Berlin]`) that Postgres rejects
 * with `22007`, and only a raw-SQL fragment can smuggle one in, where the type
 * checker cannot help. So the annotation is dropped rather than passed on: the
 * offset preceding it already fixes the instant exactly, which makes this a
 * lossless narrowing to what the column can hold.
 */
export function temporalToPostgres(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(temporalToPostgres);
	}
	if (!isTemporalValue(value)) {
		return value;
	}
	return stripZoneAnnotation(String(value));
}

/** `2026-08-10T21:18:27+02:00[Europe/Berlin]` becomes `2026-08-10T21:18:27+02:00`. */
function stripZoneAnnotation(text: string): string {
	const bracket = text.indexOf("[");
	return bracket === -1 ? text : text.slice(0, bracket);
}

/**
 * Fail early, and legibly, when the runtime has no `Temporal`.
 *
 * Called once at connection time. Without it the first row read throws a bare
 * `ReferenceError: Temporal is not defined` from inside a driver callback,
 * which tells the customer nothing about what to do.
 */
export function requireTemporal(): void {
	if (!("Temporal" in globalThis)) {
		throw new Error(
			"@databrill/core-pg-kysely returns Temporal values, but this runtime has no Temporal global. " +
				'Load a polyfill before connecting: import "temporal-polyfill/global". For the TYPES, ' +
				'TypeScript 7+ has "esnext.temporal" for its `lib`; on TypeScript 5.x or 6.x that lib ' +
				"does not exist and the same polyfill import supplies the declarations.",
		);
	}
}
