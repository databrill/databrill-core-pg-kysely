# @databrill/core-pg-kysely

[![JSR](https://jsr.io/badges/@databrill/core-pg-kysely)](https://jsr.io/@databrill/core-pg-kysely)
[![JSR score](https://jsr.io/badges/@databrill/core-pg-kysely/score)](https://jsr.io/@databrill/core-pg-kysely)
[![CI](https://github.com/databrill/databrill-core-pg-kysely/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/databrill/databrill-core-pg-kysely/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/databrill/databrill-core-pg-kysely/blob/main/LICENSE)

Typed access to a Databrill tenant database: your tenant schema as a
versioned Kysely `DB` interface, plus a connection factory whose driver
configuration makes those types true at runtime.

If you have a hosted Databrill workspace or a bring-your-own Supabase
tenant database, this package is how you query it from TypeScript with
real autocomplete and real compile errors instead of hand-written SQL
against a schema you cannot see.

## Install

```
deno add jsr:@databrill/core-pg-kysely@^0.1.0
```

The version constraint is required, not optional style. This package is still
`0.x`, and `deno add` without a constraint refuses a package whose only
releases are below `1.0.0` — it reports "has only pre-release versions
available" and does nothing.

If you install within a day of a release, Deno's minimum-dependency-age policy
(24 hours by default) will refuse the new version as well. Either wait, pass
`--min-dep-age=0` for that one install, or exempt this package for good in your
own `deno.json`:

```json
"minimumDependencyAge": { "age": "P1D", "exclude": ["jsr:@databrill/core-pg-kysely"] }
```

The exclude entry has to match the specifier you actually import with, and
nothing warns you when it does not — the wrong form is silently inert and the
install stays blocked. `jsr:@databrill/core-pg-kysely` is the one for a Deno
consumer who installed with the command above. Through JSR's npm compatibility
layer the specifier is a different string and so is the entry:
`npm:@jsr/databrill__core-pg-kysely`.

Node consumers can install through JSR's npm compatibility layer. Add an
`.npmrc` with `@jsr:registry=https://npm.jsr.io` and install
`@jsr/databrill__core-pg-kysely` as usual. The package is ESM-only. A direct
npm publish (via dnt) is not done yet; the JSR npm-compat layer is the only
path for Node today.

## Quickstart

```ts
import { checkSchemaCompatibility, createDb } from "@databrill/core-pg-kysely";

const { db, write, destroy } = createDb({
	connectionString: Deno.env.get("DATABRILL_DATABASE_URL"),
	schema: "w123456789",
});

const compatibility = await checkSchemaCompatibility(db);
if (compatibility.level === "error") {
	throw new Error(compatibility.message);
}

const listings = await db
	.selectFrom("amazon_listing_open")
	.select(["sku", "asin"])
	.limit(10)
	.execute();

await destroy();
```

## Three entry points

Which one you import decides what you pay for:

- `@databrill/core-pg-kysely` — everything, including `createDb()`. Pulls in
  `pg` and its dependency tree, because it opens connections.
- `@databrill/core-pg-kysely/types` — the schema types. Type-only and
  literally erased: importing it emits no JavaScript and pulls in no
  dependency at all. Use it for typing rows, writing helpers over the schema,
  or building your own Kysely instance.
- `@databrill/core-pg-kysely/contract` — the contract as runtime values:
  `SCHEMA_VERSION`, `SCHEMA_HASH`, `WRITABLE_TABLE_NAMES`, `TABLE_NAMES`
  and `VIEW_NAMES`. Also free of `pg`, so checking which schema version you
  were built against does not cost a database driver.

```ts
import { SCHEMA_VERSION, TABLE_NAMES, VIEW_NAMES } from "@databrill/core-pg-kysely/contract";
```

`TABLE_NAMES` and `VIEW_NAMES` are the published tables and the published
views, each sorted, as plain string arrays; together they are exactly the
names `db.selectFrom()` accepts. Two lists rather than one because the
difference is part of the contract — views are the surface to prefer, as
"Stability and versioning" explains — and `[...TABLE_NAMES, ...VIEW_NAMES]`
is the flat list whenever you want it. What they are for is checking which
of those relations your own workspace has; see "Read and write" below.

Everything the two narrow entry points export is re-exported from the package
root as well, so importing everything from `@databrill/core-pg-kysely` is always
correct — the split exists only so you can avoid the driver when you do not
need it.

## Type names

A relation's row type is named after the relation, prefixed by what it is:
`DbTable_amazon_country`, `DbView_amazon_listing_open`. The physical name is
kept verbatim, including the double underscores and casing Amazon's API
naming produces — `DbTable_wmt_orders_v3__Order`, not a PascalCase rewrite of
it. So the type for any table you can name in `selectFrom()` is that name
with a prefix, and nothing has to be looked up.

Remember that a selected row is `Selectable<DbTable_x>`, not `DbTable_x`
itself: the interface describes a column's select, insert and update types
together, which is what lets `Generated<T>` columns be required on read and
optional on write.

```ts
import type { Selectable } from "kysely";
import type { DbView_amazon_listing_open } from "@databrill/core-pg-kysely/types";

type OpenListing = Selectable<DbView_amazon_listing_open>;
```

## Read and write

`createDb()` hands back two Kysely instances sharing one connection pool:

- `db` covers every published table and view. Inserts, updates, deletes,
  and DDL against it are compile-time type errors — it is typed as
  Kysely's `ReadonlyKysely<DB>`.
- `write` covers only the tables customers are meant to write:
  - `brand_config_amazon_asin`
  - `brand_config_amazon_attributes`
  - `brand_config_amazon_family`
  - `brand_config_business_attributes`
  - `brand_config_ontology_category`
  - `brand_config_ontology_metadata`
  - `brand_config_ontology_variant`

This split is a compile-time check, nothing more. The enforceable
boundary is the grants held by the database role in your connection
string. A compile error from `db` is a hint that you meant `write`, never
proof that a write could not happen — do not treat the types as a
security control.

The same limit applies to which relations exist. `DB` names every
relation Databrill can provision, and any one workspace holds a subset of
them, so `db.selectFrom("amazon_listing_open")` type-checks whether or
not your schema has that view and then fails at runtime with `relation
does not exist`. A name type-checking is not evidence the relation is
there. `TABLE_NAMES` and `VIEW_NAMES` from
`@databrill/core-pg-kysely/contract` are the full published list, and one
query says which of them you actually have (`pool` is the third thing
`createDb()` returns; see "The pool" below):

```ts
import { TABLE_NAMES, VIEW_NAMES } from "@databrill/core-pg-kysely/contract";

const { rows } = await pool.query(
	"select table_name from information_schema.tables where table_schema = $1",
	["w123456789"],
);
const present = new Set(rows.map((row) => String(row.table_name)));
const missing = [...TABLE_NAMES, ...VIEW_NAMES].filter((name) => !present.has(name));
```

`information_schema.tables` lists views alongside tables (a view has
`table_type = 'VIEW'`), so that one query covers both lists. It also
shows only relations your role holds some privilege on, which is the
right answer here: one you cannot read is one you cannot query.

## Your connection string

`DATABRILL_DATABASE_URL` is a Postgres URI for one of two database roles
your workspace has, and which one you were given decides what the
connection can do:

- `w{wsid}_ro` — reads every table and view in your workspace schema and
  writes nothing.
- `w{wsid}_rw` — the same reads, plus `INSERT`, `UPDATE` and `DELETE` on
  exactly the tables listed under "Read and write" above. It never has
  `TRUNCATE`, and it cannot write anything else, including the tables the
  Databrill pipeline populates.

So `db` and `write` line up with the `_rw` role's real privileges. On a
`_ro` credential, `write` still type-checks and the database refuses the
statement — the types are a compile-time check, the grants are the
boundary.

Ask for whichever role you need; a single workspace can hand out both.
Databrill issues these one workspace and one role at a time, deliberately,
and the credential is meant to live in your environment or secret store
rather than in a repository.

One property to plan around: these passwords are derived rather than
stored, so there is no per-workspace rotation. If a credential has to be
invalidated, Databrill rotates the master secret and reprovisions every
role on every database, which changes every workspace's password at once.
Treat the URI as a long-lived secret and tell us promptly if it is
exposed, so the rotation can be scheduled rather than emergency-run.

The URI's `sslmode` parameter is read by `createDb()` and applied with
libpq's meanings, which are not the ones `pg` gives it — see "TLS and
`sslmode`" under "Connection options" before you rely on either.

## Runtime requirements

Values come back as `Temporal` objects, so the runtime needs `Temporal`.
Newer runtimes have it built in; check yours with
`typeof globalThis.Temporal`. Where it is missing, load a polyfill before
connecting, `import "temporal-polyfill/global"`, or `createDb()` throws a
clear error explaining exactly that at connection time rather than a bare
`ReferenceError` on your first row read.

TypeScript needs the `Temporal` type declarations too, which is a separate
question from whether your runtime has the object:

- Deno provides them by default. Nothing to configure.
- TypeScript 7 and later ship them: add `"lib": ["esnext.temporal"]` (or
  `"esnext"`) to `tsconfig.json`.
- TypeScript 5.x and 6.x do not have that lib at all, so the setting above
  is not available to you. Install `temporal-polyfill` and
  `import "temporal-polyfill/global"` — it supplies the global type
  declarations along with the runtime object. A runtime that already has
  `Temporal` still needs this import (or a TypeScript 7 upgrade) to get the
  types.

## Value mapping

- `timestamptz` → `Temporal.Instant` — an exact instant, offset included.
- `timestamp` (no time zone) → `Temporal.PlainDateTime` — a wall-clock
  reading with no offset. This is deliberate: the column genuinely does
  not know which moment it was, and typing it as an `Instant` or a `Date`
  would invent a zone that is not there.
- `date` → `Temporal.PlainDate`.
- `numeric`, and `bigint`/`int8` → `string`. A `numeric` is a string
  because it can carry more precision than a JavaScript `number` can hold
  without loss; converting it silently would be a correctness bug wearing
  a convenience costume.
- `jsonb` → an untyped `Json` union (`JsonValue`), refinable per column in
  future generations if a column's shape is worth typing precisely.

All three temporal columns also accept an ISO-8601 string on insert or
update, alongside the Temporal value — both are unambiguous, and a
`temporalParameterPlugin` installed by `createDb()` renders the Temporal
case to the text Postgres expects before it reaches the driver.

That string alternative applies to writes only. A `where` comparison is
typed against the column's SELECT type, which is the Temporal value, so
`.where("updatedAt", ">", "2026-08-10T00:00:00Z")` does not type-check —
pass `Temporal.Instant.from("2026-08-10T00:00:00Z")` instead. That is
Kysely's rule about how `ColumnType` is read in each position, not a
choice this package made.

Two Postgres values have no Temporal representation: the `infinity` /
`-infinity` sentinels, and BC dates. Neither is produced by any column in
the published schema, but Postgres permits them, and reading one throws
`UnrepresentableTemporalValueError` rather than silently substituting some
nearby instant. If you need to read such a value, select the column as
text instead (`sql<string>\`your_column::text\``).

## Bring your own dialect

If you build your own Kysely instance against these types instead of
using `createDb()`, you need to reproduce the same driver configuration
yourself, or the types will lie. The package exports what you need:

- `pgTypeParsers` / `makePgTypes()` — the `pg` driver type parsers for the
  three temporal OIDs.
- `temporalParameterPlugin` — the Kysely plugin that renders Temporal
  values into query parameters.

Raw `pg`, without either of these, returns `Date` objects for
`timestamptz`/`timestamp`/`date` columns, and its own parameter
serializer JSON-stringifies a Temporal value into a quoted string that
Postgres rejects. Both problems are silent until they are not — the query
type-checks and then hands back the wrong runtime shape.

This section is about a pool you opened yourself. The one `createDb()`
returns cannot stand in for it: `pool` is typed as `TenantPool`, narrowed
on purpose so that nothing you import from here obliges you to install
`@types/pg`, and passing it to `PostgresDialect` does not compile:

```
Type 'TenantPool' is not assignable to type 'PostgresPool | ((options?) => Promise<PostgresPool>)'
```

If what you wanted was raw SQL against the pool this package already
opened, that is `pool.query(text, values)` rather than a second Kysely
instance; see "The pool" below.

## Connection options

`createDb()` takes either a connection string or an options object:

```ts
createDb(Deno.env.get("DATABRILL_DATABASE_URL")!);

createDb({
	connectionString: Deno.env.get("DATABRILL_DATABASE_URL"),
	schema: "w123456789",
	max: 10,
	application_name: "reporting-worker",
});
```

`CreateDbOptions` is a declared subset of what `pg` accepts rather than
a re-export of its `PoolConfig`. It covers where to connect
(`connectionString`, or `host` / `port` / `user` / `password` /
`database`, plus `ssl`), pool sizing and lifetime (`max`, `min`,
`idleTimeoutMillis`, `connectionTimeoutMillis`, `maxUses`,
`maxLifetimeSeconds`, `allowExitOnIdle`), what the server is told
(`application_name`, `statement_timeout`, `query_timeout`,
`idle_in_transaction_session_timeout`, `lock_timeout`), and this
package's own `schema`. The driver's internal hooks are not forwarded:
replacing the client class would lose the type parsers that make the
published types true, which is the one thing this package exists to
guarantee.

Adding an optional option later is a compatible change, so if you need
one that is not there, ask.

`ssl` takes `true` or a `TenantTlsOptions` object — `rejectUnauthorized`,
`ca`, `cert`, `key`, `servername`. The three certificate fields are
`string` where `pg` also accepts a `Buffer`, so a certificate you read
from disk as bytes needs `.toString()` before you pass it.

### TLS and `sslmode`

`createDb()` reads `sslmode` out of your connection string and applies
**libpq's** meanings to it, not `pg`'s. That difference is the whole
reason this exists: since 8.16, `pg` treats `prefer`, `require` and
`verify-ca` as aliases for `verify-full`, so a `sslmode=require` URL that
connects fine with `psql` fails here with `self-signed certificate in
certificate chain` against a pooler — Supabase's among them — whose chain
does not verify against the public root store. Through `createDb()`,
`require` means what libpq means: encrypted, not verified.

| `sslmode` | What you get |
| --- | --- |
| `verify-full` | The chain and the hostname are both verified. |
| `verify-ca` | An error: it needs a CA, and a CA can only arrive through `ssl` — see below. |
| `require`, `prefer` | Encrypted, not verified. |
| `allow` | The same: encrypted, not verified. |
| `disable` | No TLS. |
| anything else | An error naming the valid modes. |

Modes are matched exactly, so `sslmode=Require` is an error rather than
something silently different from what you wrote.

`verify-ca` **requires a CA and throws without one**. Verifying a chain
against the public root store and skipping the hostname check accepts any
publicly-trusted certificate for any hostname, which is not a check at
all. Pass the certificate contents as `ssl: { ca }`. Note that an
explicit `ssl` takes precedence over the string, so that combination
hands `pg` your object as you wrote it — chain and hostname both, which
is `verify-full`. If you need libpq's `verify-ca` exactly, with a CA and
no hostname check, ask and we will add a way to say so.

`prefer` and `allow` are approximations. In libpq they try one transport
and fall back to the other; `pg` has no downgrade path, so both are
implemented here as "always TLS, unverified". That is stronger than libpq
for `allow`, and it can only fail where libpq would have connected in
plaintext.

**An explicit `ssl` option wins over the connection string.** A customer
holding a private root CA writes

```ts
createDb({ connectionString: "postgres://…?sslmode=verify-full", ssl: { ca } });
```

and the `ca` survives. This was previously not true, and silently: `pg`
merges the parsed connection string over the config you handed it, and
the parse overwrites `ssl` whenever the string mentions TLS at all, so
the `ca` above used to be discarded before the pool ever saw it.
`createDb()` now removes the `sslmode` it has consumed from the string,
which is what makes your option stick. The mode itself is then not
consulted at all, so an unrecognised one does not raise the error the
table above describes — your `ssl` decided it.

**No `sslmode` in the string means this package sets nothing**, so `pg`'s
own default and the `PGSSLMODE` environment variable both still apply,
exactly as before. That is deliberate rather than an oversight — but a
bare URL connects in plaintext, so write `sslmode=require` on any
connection that crosses a network, and `sslmode=verify-full` with a `ca`
where you can.

`sslrootcert=` is **not** read from disk by this package, and neither are
`sslcert=` and `sslkey=`. This package does no filesystem access of its
own, so those three are left in the string for `pg` to handle; pass the
certificate contents as `ssl: { ca }` instead.

Be aware of what "left for `pg` to handle" means, because it is not
"ignored". `pg` reads those three files itself, synchronously, while it
parses the connection string inside `new Pool()` — so `createDb()` throws
`ENOENT` right there if the path is wrong, rather than failing later on
connect, and under Deno the read needs `--allow-read` from you even
though the code doing it is not ours.

One consequence is worth knowing, and it is the sharp edge of this
section. Because those three are left in the string, a URL carrying any
of them still reaches the driver's own "the string mentions TLS" branch,
which builds an `ssl` object of its own and merges it **over** everything
else. So on a URL that combines `sslmode=` with `sslcert=`, `sslkey=` or
`sslrootcert=`, neither guarantee above holds: the table's mapping is
discarded and you get `pg`'s TLS behaviour, and an explicit `ssl` option
is discarded too. The same is true of `ssl=true`, `ssl=1` and
`sslnegotiation=direct` in the URL. Keep all of those out of the
connection string and pass certificate contents through `ssl` instead.

## The `schema` option

`createDb({ schema, ... })` targets a Postgres schema — `w123456789` for a
hosted workspace, typically `public` for a bring-your-own Supabase
project. It is applied through Kysely's own `withSchema()`, which
qualifies identifiers in the SQL Kysely emits, not through a driver-level
`search_path`. That is deliberate: a `search_path` startup parameter is
not forwarded by every connection pooler, and a per-session `SET` does
not survive transaction-mode pooling, where each transaction may land on
a different backend. Qualifying the SQL itself works regardless of how
the connection is pooled.

## The pool

`createDb()` also returns `pool`, the connection pool both surfaces
share, for connection metrics and for SQL this package cannot express:

```ts
const { db, pool, destroy } = createDb(/* ... */);

console.log(pool.totalCount, pool.idleCount, pool.waitingCount);
const { rows } = await pool.query("select now() as at");

// Your own listener for errors on idle clients; it does not displace
// the one this package attaches.
pool.on("error", (error) => console.warn(error));

await destroy();
```

It is typed as `TenantPool`, a type this package declares rather than
`pg`'s own `Pool`, so nothing you import from here obliges you to
install `@types/pg`. It carries the three connection counts, `ended`,
`query()` and `on("error", ...)`, and nothing else.

`connect()` and `end()` are deliberately absent. Close through
`destroy()`, which drains the pool once and invalidates both surfaces —
there is one pool, so there is one teardown. If you need a member
`TenantPool` does not carry, ask; adding one is a compatible change.

## Schema compatibility

`checkSchemaCompatibility(db)` compares the schema contract this package
was generated against with the version recorded in the connected
database, and returns a result rather than throwing:

- `ok` — versions match.
- `warning` — additive skew. Your existing queries are unaffected either
  way; one side simply knows about tables or columns the other does not
  yet.
- `error` — breaking skew. Queries the types permit may fail at runtime,
  or read the wrong thing.
- `unknown` — the database records no version, or the row could not be
  read (for example on a permissions error). Not an assertion in either
  direction.

Minor skew warns instead of throwing on purpose. Tenant databases are
migrated fleet-wide before a matching package version is published, so
there is always a window where a customer's database is one additive
step ahead of their installed package. Throwing there would turn every
routine rollout into a customer-visible outage over changes that cannot
break existing queries.

## Keeping compile cost down

The generated `DB` interface covers every published table and view,
which is a lot of surface for TypeScript to hold in memory on every
query. If you only ever touch a handful of tables, narrow it:

```ts
const narrowDb = db.$pickTables<"amazon_listing_open" | "amazon_order">();
```

`$pickTables` is Kysely's own API, available on both the read and write
surfaces, and returns a Kysely instance typed over just the tables named.

## Stability and versioning

This package is `0.x`. Views are the most stable surface — treat them as
the contract. Raw tables may change with notice as the underlying schema
evolves; a view is Databrill's way of keeping a stable shape in front of
that.

Version bumps are decided by diffing the generated artifact, not by
recollection:

- Major: a dropped table, view, column, or enum value; a narrowed column
  type; or a new non-nullable column on a selectable surface.
- Minor: a new table or view, or a new nullable column.
- Patch: comments, overrides, and documentation only.

Adding a new value to a Postgres enum counts as a breaking change, not an
additive one, even though it looks like an addition. An exhaustive
`switch` over the union in consumer code breaks the moment a new member
appears, so from a consumer's point of view this is exactly as breaking
as removing a member would be.

While the package stays in the `0.x` series, semver's normal zero-major
convention applies: the breaking component is the minor slot and the
additive component is the patch slot, i.e. `0.MINOR.PATCH` reads like
`MAJOR.MINOR` would after a 1.0. `checkSchemaCompatibility()` implements
exactly this rule when it compares versions.

Types are only published for a schema already live in every tenant
database — the rollout order is expand, migrate the fleet, publish types,
then contract. A published version never describes a schema that does
not exist yet somewhere.

### The package version is not the schema version

`SCHEMA_VERSION`, exported from this package, is the schema contract.
The package version in `deno.json` is the released library, which also
changes for reasons your database cannot observe: a documentation fix, a
runtime bug fix, a new export. Those releases move the package's patch
number while `SCHEMA_VERSION` stays put.

The two always agree in their leading two components, so package `0.2.x`
is always the `0.2.x` contract and a breaking schema change is always
visible in the version you install. Only the patch slot floats. When you
need to know exactly which contract a build carries, read
`SCHEMA_VERSION` rather than the package version — and
`checkSchemaCompatibility()` already does.

One consequence for the range you pin: because the minor slot belongs to
the schema, a change that breaks the library without changing the schema
lands in the patch slot as well. No range excludes that: every range you
would write admits patch releases, and while the package is `0.x` a tilde
range and a caret range are the same range. A consumer who cannot absorb
such a change has to pin an exact version and move it deliberately.

## No migrations

This package ships no migrations, and your database role is not expected
to hold DDL privileges. Databrill applies all schema changes to the
tenant schema; you get new tables, views, and columns by upgrading the
package, not by running anything yourself.

Any additional tables you create in your own database are yours to
manage and are outside this package's contract entirely — it has no
opinion about them and will never touch them. If you want a migration
tool for your own tables, Kysely ships its own `Migrator`; wire it up in
your own repository against your own migration files.

## A note for npm consumers: duplicate Kysely

JSR has no `peerDependencies` concept, so an npm-compatibility consumer
can end up with two separate copies of `kysely` in `node_modules` — one
this package depends on, one your own project depends on directly. Since
Kysely's `Kysely` class carries a `#private` field, it is nominally
typed: two structurally identical `Kysely` types from two different
copies of the package are not assignable to each other, which shows up
as baffling type errors that have nothing obviously to do with duplicate
packages. If you hit this, dedupe to a single copy of `kysely` (your
package manager's dedupe command, or pinning both to the same version).

## Reporting problems

The public repository this package is mirrored to is a publish-only
mirror of an internal monorepo. Issues and pull requests are disabled
there; if something is wrong, reach out to Databrill directly.
