# @databrill/core-pg-kysely

Typed access to a Databrill tenant database: your tenant schema as a
versioned Kysely `DB` interface, plus a connection factory whose driver
configuration makes those types true at runtime.

If you have a hosted Databrill workspace or a bring-your-own Supabase
tenant database, this package is how you query it from TypeScript with
real autocomplete and real compile errors instead of hand-written SQL
against a schema you cannot see.

## Install

```
deno add jsr:@databrill/core-pg-kysely
```

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
	schema: "w100000660",
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

If you only need the schema types, with no `pg` or connection dependency
at all, import from `@databrill/core-pg-kysely/types` instead — useful for
typing rows or building your own Kysely instance.

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

This split is a compile-time affordance, nothing more. The enforceable
boundary is the grants held by the database role in your connection
string. A compile error from `db` is a hint that you meant `write`, never
proof that a write could not happen — do not treat the types as a
security control.

## Runtime requirements

Values come back as `Temporal` objects, so the runtime needs `Temporal`.
It is native in Deno and in Node 26+. On Node 24 and on Bun it is not yet
built in: load a polyfill before connecting, `import "temporal-polyfill/global"`,
or `createDb()` throws a clear error explaining exactly that at connection
time rather than a bare `ReferenceError` on your first row read.

TypeScript needs the `Temporal` type declarations too, which is a separate
question from whether your runtime has the object:

- Deno provides them by default. Nothing to configure.
- TypeScript 7 and later ship them: add `"lib": ["esnext.temporal"]` (or
  `"esnext"`) to `tsconfig.json`.
- TypeScript 5.x and 6.x do not have that lib at all, so the setting above
  is not available to you. Install `temporal-polyfill` and
  `import "temporal-polyfill/global"` — it supplies the global type
  declarations along with the runtime object. Node 26 users who do not
  need the runtime polyfill still need this import (or a TypeScript 7
  upgrade) to get the types.

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

## The `schema` option

`createDb({ schema, ... })` targets a Postgres schema — `w100000660` for a
hosted workspace, typically `public` for a bring-your-own Supabase
project. It is applied through Kysely's own `withSchema()`, which
qualifies identifiers in the SQL Kysely emits, not through a driver-level
`search_path`. That is deliberate: a `search_path` startup parameter is
not forwarded by every connection pooler, and a per-session `SET` does
not survive transaction-mode pooling, where each transaction may land on
a different backend. Qualifying the SQL itself works regardless of how
the connection is pooled.

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
