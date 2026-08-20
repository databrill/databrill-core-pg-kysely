/** An explicit inclusive date range, or a trailing number of inclusive days. */
export type CanonicalWindow =
	| { readonly kind: "explicit"; readonly dateFirst: string; readonly dateLast: string }
	| { readonly kind: "trailingDays"; readonly days: number };

/** The inclusive dates a canonical reader resolved for one request. */
export interface CanonicalResolvedWindow {
	readonly dateFirst: string;
	readonly dateLast: string;
	/** How the end of the window was chosen. */
	readonly anchoredOn: "maxDefinitiveDate" | "explicit";
}

/**
 * Resolve a request window against this reader's own source freshness.
 *
 * A trailing window includes both ends: seven days ending on D starts on D-6.
 */
export function resolveCanonicalWindow(
	requested: CanonicalWindow,
	anchorDate: string,
): CanonicalResolvedWindow {
	if (requested.kind === "explicit") {
		return { dateFirst: requested.dateFirst, dateLast: requested.dateLast, anchoredOn: "explicit" };
	}
	const last = Temporal.PlainDate.from(anchorDate);
	const first = last.subtract({ days: Math.max(requested.days - 1, 0) });
	return { dateFirst: first.toString(), dateLast: last.toString(), anchoredOn: "maxDefinitiveDate" };
}
