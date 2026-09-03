import type { TenantTlsOptions } from "./createDb.ts";

// `sslmode`, read off the connection string and applied with LIBPQ's meanings.
//
// Nothing here is exported from `mod.ts`, `types.ts` or `contract.ts`. Every
// name published from a 0.x package is a name that has to keep working, and
// which query parameters this package consumes is an implementation detail.
// The package's own tests import it by relative path.
//
// Nothing here imports anything at runtime: `URL` and `URLSearchParams` are
// globals. Keep it that way — this module is the reason the feature needed no
// new dependency.
//
// Why hand-rolled rather than `pg-connection-string`'s `uselibpqcompat=true`:
// that mode does not cover `allow` (it falls through to verify-full, the
// opposite of libpq), its `verify-ca` throws without a CA so the behaviour has
// to be documented here anyway, and it would make this package's published TLS
// semantics a function of whichever transitive `pg-connection-string` a
// customer's lockfile resolved, while the declared floor is only `pg@^8.16.3`.

/**
 * The `ssl` object this package builds for `new Pool()` from a `sslmode`.
 *
 * `checkServerIdentity` is libpq's `verify-ca`: verify the certificate chain,
 * do not verify the hostname. It is deliberately absent from
 * {@link TenantTlsOptions} — declaring it publicly would put a `node:tls`
 * `PeerCertificate` into the published type surface. Typed here as a function
 * of no arguments returning `undefined`, which pulls in nothing; `pg` calls it
 * with a hostname and a certificate and ignores the extra arguments.
 */
export interface ResolvedTlsConfig {
	readonly rejectUnauthorized: boolean;
	readonly ca?: string;
	readonly cert?: string;
	readonly key?: string;
	readonly servername?: string;
	readonly checkServerIdentity?: () => undefined;
}

/** What {@link resolveSslMode} decided: the string to connect with, and the `ssl` to connect with. */
export interface SslModeResolution {
	/** The connection string with the consumed TLS parameters removed. */
	readonly connectionString: string;
	/**
	 * What to pass as `ssl`, or `undefined` to set nothing at all.
	 *
	 * The distinction matters: `pg` reads `PGSSLMODE` from the environment only
	 * while `ssl` is `undefined`, so setting it unconditionally would take that
	 * variable away from every customer.
	 */
	readonly ssl: boolean | TenantTlsOptions | ResolvedTlsConfig | undefined;
}

/** The modes libpq accepts, in its own order, for the error message. */
const SSL_MODES: readonly string[] = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];

/**
 * The query parameters this package reads and therefore removes.
 *
 * `sslcert`, `sslkey` and `sslrootcert` are deliberately NOT here: they name
 * files, `pg-connection-string` reads them with `fs`, and this package does no
 * filesystem access. They are left in the string for `pg` to handle.
 */
const CONSUMED_PARAMETERS: readonly string[] = ["sslmode", "uselibpqcompat"];

/**
 * Map one `sslmode` value to the `ssl` option `pg` should be given.
 *
 * libpq's semantics, not `pg`'s. `pg` 8.16+ treats `prefer`, `require` and
 * `verify-ca` as aliases for `verify-full`, so a `sslmode=require` URL that
 * works with `psql` fails against a pooler whose chain does not verify against
 * the public root store. Here `require` means what libpq means: encrypted, not
 * verified.
 *
 * Two approximations, stated in the README rather than pretended away: `pg` has
 * no downgrade path, so `prefer` and `allow` — which in libpq try one transport
 * and fall back to the other — are "always TLS, unverified" here.
 *
 * Compared case-sensitively, matching `pg-connection-string`'s own switch:
 * `sslmode=Require` throws rather than quietly meaning something.
 *
 * @param mode the raw value read from the connection string
 * @param ca the CA the caller supplied, if any; `verify-ca` refuses without one
 */
export function tlsConfigForSslMode(mode: string, ca: string | undefined): boolean | ResolvedTlsConfig {
	switch (mode) {
		case "disable":
			return false;
		case "allow":
		case "prefer":
		case "require":
			return { rejectUnauthorized: false };
		case "verify-ca":
			// The same refusal `pg-connection-string`'s libpq-compat branch
			// makes, and for the same reason: `verify-ca` against the public
			// root store accepts any publicly-trusted certificate for any
			// hostname, which is not what anyone writing `verify-ca` wants.
			if (ca === undefined) {
				throw new Error(
					`sslmode=verify-ca needs a certificate authority, and none was supplied. Pass the ` +
						`certificate contents as ssl: { ca } — an explicit ssl option takes precedence over ` +
						`the connection string. Verifying against the public root store instead would accept ` +
						`any publicly-trusted certificate for any hostname. This package does not read ` +
						`sslrootcert= from disk.`,
				);
			}
			return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
		case "verify-full":
			return { rejectUnauthorized: true };
		default:
			throw new Error(
				`Invalid sslmode ${JSON.stringify(mode)} in the connection string: expected one of ` +
					`${SSL_MODES.join(", ")}. Modes are matched exactly, so the spelling is case-sensitive.`,
			);
	}
}

/**
 * Decide what `createDb()` connects with, given a connection string and the
 * caller's `ssl` option.
 *
 * Two things happen here, and both are needed:
 *
 * 1. `sslmode` is mapped through {@link tlsConfigForSslMode}.
 * 2. The parameters this package has consumed are REMOVED from the string.
 *    Without the removal the whole thing is a no-op: `pg` merges the parsed
 *    connection string OVER the config it was handed, and
 *    `pg-connection-string` writes `config.ssl = {}` whenever the string
 *    mentions TLS at all. That is also the bug that silently discarded a
 *    caller's CA bundle.
 *
 * An explicit `ssl` wins over the string. When `callerSsl` is anything other
 * than `undefined` — `false` included — it is what comes back, the `sslmode` is
 * not consulted, and so a typo'd mode does not throw. The parameters are still
 * stripped, because the stripping is the only thing that stops the string
 * overriding the caller.
 *
 * No `sslmode` in the string means nothing changes: the string comes back
 * byte-identical and `ssl` is whatever the caller passed, `undefined` included.
 * A libpq key/value DSN, a unix socket path, and anything whose scheme is not
 * `postgres:`/`postgresql:` also pass through untouched.
 */
export function resolveSslMode(
	connectionString: string,
	callerSsl: boolean | TenantTlsOptions | undefined,
): SslModeResolution {
	const unchanged: SslModeResolution = { connectionString, ssl: callerSsl };

	// `pg-connection-string` treats a leading `/` as a unix socket path, and a
	// libpq key/value string does not parse as a `URL` at all. Both are handed
	// back byte-identical for `pg` to do whatever it does.
	if (connectionString.startsWith("/")) {
		return unchanged;
	}
	const url = parseConnectionUri(connectionString);
	if (url === undefined) {
		return unchanged;
	}

	// The LAST occurrence wins, matching `pg-connection-string`, which assigns
	// each entry of `searchParams` over the last. `URLSearchParams.get()`
	// returns the FIRST, so acting on it would apply a different mode from the
	// one `pg` would have seen.
	const modes = url.searchParams.getAll("sslmode");
	const mode = modes.length === 0 ? undefined : modes[modes.length - 1];
	if (mode === undefined) {
		return unchanged;
	}

	// An explicit `ssl` wins outright, so the mode is not consulted and an
	// unrecognised one does not throw. The parameters are still stripped: the
	// stripping is the only thing that stops the string overriding the caller.
	if (callerSsl !== undefined) {
		return { connectionString: stripConsumedParameters(connectionString), ssl: callerSsl };
	}

	// The CA is `undefined` here and can only ever be: one reaches this package
	// through the `ssl` option, and that option has returned above. So
	// `sslmode=verify-ca` always throws today, and the branch of
	// `tlsConfigForSslMode` that builds a `checkServerIdentity` config is
	// reachable only by calling the mapping directly. That is decision 1 (an
	// explicit `ssl` wins) and decision 5 (`verify-ca` needs a CA) composing,
	// not an oversight; the README states the consequence outright.
	return {
		connectionString: stripConsumedParameters(connectionString),
		ssl: tlsConfigForSslMode(mode, undefined),
	};
}

/**
 * Parse the string as a Postgres URI, or `undefined` if it is not one.
 *
 * The `@/` retry mirrors `pg-connection-string`'s own fallback
 * (`index.js`, the `___DUMMY___` replacement). WHATWG `URL` rejects the
 * host-less form `postgres://user:pass@/dbname`, which libpq and `pg` both
 * accept — the host comes from `PGHOST` or the default socket. Without the retry
 * that form reads as "not a URL", keeps its `sslmode`, and gets `pg`'s meanings
 * for it rather than this module's, which is the one thing this module exists to
 * stop. The dummy host is never used for anything but finding the query.
 */
function parseConnectionUri(connectionString: string): URL | undefined {
	for (const candidate of [connectionString, connectionString.replace("@/", "@___DUMMY___/")]) {
		let url: URL;
		try {
			url = new URL(candidate);
		} catch {
			continue;
		}
		return url.protocol === "postgres:" || url.protocol === "postgresql:" ? url : undefined;
	}
	return undefined;
}

/**
 * Remove the consumed parameters from the query, textually.
 *
 * Deliberately NOT `new URL(...).toString()`: that re-encodes userinfo, host
 * and path — `%2f`-encoded unix-socket hosts, spaces, oddly encoded passwords —
 * and can change what `pg-connection-string` then parses. Only the query
 * component is rewritten, and the surviving pairs are re-joined exactly as they
 * were written.
 */
function stripConsumedParameters(connectionString: string): string {
	const queryStart = connectionString.indexOf("?");
	if (queryStart === -1) {
		return connectionString;
	}
	// A `?` after a `#` is part of the fragment, not a query.
	const firstHash = connectionString.indexOf("#");
	if (firstHash !== -1 && firstHash < queryStart) {
		return connectionString;
	}
	const hashIndex = connectionString.indexOf("#", queryStart);
	const rawQuery = hashIndex === -1
		? connectionString.slice(queryStart + 1)
		: connectionString.slice(queryStart + 1, hashIndex);
	const fragment = hashIndex === -1 ? "" : connectionString.slice(hashIndex);
	const head = connectionString.slice(0, queryStart);

	const kept = rawQuery.split("&").filter(function isKept(rawPair: string): boolean {
		return !CONSUMED_PARAMETERS.includes(decodeQueryComponent(rawKey(rawPair)));
	});
	if (kept.length === 0) {
		return head + fragment;
	}
	return `${head}?${kept.join("&")}${fragment}`;
}

/** The raw, still-encoded key of one `k=v` pair. */
function rawKey(rawPair: string): string {
	const separator = rawPair.indexOf("=");
	return separator === -1 ? rawPair : rawPair.slice(0, separator);
}

/**
 * Decode a query key the way `URLSearchParams` does, so the comparison sees the
 * same name the parser did. Malformed percent escapes decode to themselves
 * rather than throwing — a key this package does not recognise is a key it
 * leaves alone.
 */
function decodeQueryComponent(raw: string): string {
	const spaced = raw.replaceAll("+", " ");
	try {
		return decodeURIComponent(spaced);
	} catch {
		return spaced;
	}
}
