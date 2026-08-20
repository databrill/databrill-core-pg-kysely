/**
 * What a canonical reader IS, as data.
 *
 * A canonical reader is declared once — its grain, the levels it can be grouped
 * to, its measures each with an additivity classification, its filters, and the
 * database relations it needs — and the protocols are projections of that
 * declaration: the MCP tool contract today, GraphQL fields and an OpenAPI
 * document later. Writing the shapes once is the point; writing them three times
 * is what this format exists to prevent.
 *
 * There is deliberately NO derivation machinery here. The rule from the design
 * note is to declare two readers, hand-write both projections, and extract a
 * generator only when a third repeats the same code — a generator designed
 * before three real cases exist encodes the wrong abstraction, and this
 * declaration is the artifact everything else hangs off.
 *
 * The classification that earns its keep immediately is {@link
 * CanonicalAdditivity}. A measure that must not be summed across products, or a
 * ratio that must be recomputed rather than averaged, is a fact about the
 * measure, not about one query — and a projection that exposes it as a plain
 * summable column produces a wrong number with no error anywhere.
 */

/**
 * Shared Amazon group-by vocabulary. The product levels are ordered coarsest
 * to finest; `SEARCH_QUERY` is an independent dimension.
 *
 * A declaration lists the subset it supports; nothing here says every reader
 * offers all of them.
 *
 * THIS LIST IS NOT A STRICT HIERARCHY, and an implementation that treats it as a
 * roll-up chain is wrong. Amazon assigns a different parent ASIN per
 * marketplace, so `PARENT_ASIN` always carries `marketplaceId` in its key, while
 * an ASIN is the same product everywhere and `ASIN` rolls up across
 * marketplaces freely. One ASIN can therefore sit under different parents in
 * different marketplaces, and `PARENT_ASIN` rows cannot be produced by
 * re-aggregating `ASIN` rows. Every level must aggregate from the source grain.
 *
 * `BRAND` is absent on purpose. The only brand-shaped column in the tenant
 * schema is `amzspapi_searchCatalogItems_v2020__asin.brandName`, which is
 * Amazon's catalogue brand rather than a customer-curated one, and the
 * `brand_config_*` tables carry family, variant and category, not a brand name.
 * Adding a level later is additive; changing what one means is not.
 */
export const CANONICAL_LEVELS = [
	"SUM",
	"MERCHANT",
	"COUNTRY",
	"STORE",
	"FAMILY",
	"PARENT_ASIN",
	"ASIN",
	"SKU",
	"SEARCH_QUERY",
] as const;

export type CanonicalLevel = typeof CANONICAL_LEVELS[number];

/** Output time bucket. `TOTAL` collapses the whole window into one row per key. */
export const CANONICAL_TIME_GRANULARITIES = ["DAY", "WEEK", "MONTH", "TOTAL"] as const;

export type CanonicalTimeGranularity = typeof CANONICAL_TIME_GRANULARITIES[number];

/**
 * The axes a measure may or may not be summed along.
 *
 * Coarser than the level list on purpose: additivity is a property of the
 * measure against a KIND of axis. Sessions do not add across products whether
 * the products in question are SKUs, ASINs or families, and saying that once is
 * both shorter and harder to get wrong than enumerating levels.
 */
export const CANONICAL_AXES = ["DATE", "PRODUCT", "STORE", "MERCHANT", "SEARCH_QUERY"] as const;

export type CanonicalAxis = typeof CANONICAL_AXES[number];

/**
 * How a measure behaves under aggregation.
 *
 * - `ADDITIVE` — summable along every axis.
 * - `SEMI_ADDITIVE` — summable along some axes and not others, each named.
 * - `RATIO` — must be RECOMPUTED from a numerator and a denominator at the
 *   output grain. Averaging the source rows' values is the classic wrong answer
 *   and it is wrong without any error: it produces a plausible number.
 * - `NON_ADDITIVE` — has no defined value above the source grain at all, because
 *   the weights needed to combine it are not in the data. A projection may offer
 *   such a measure only when the requested grain IS the source grain.
 */
export type CanonicalAdditivity =
	| { readonly kind: "ADDITIVE" }
	| {
		readonly kind: "SEMI_ADDITIVE";
		readonly summableAcross: readonly CanonicalAxis[];
		readonly notSummableAcross: readonly CanonicalAxis[];
		readonly reason: string;
	}
	| {
		readonly kind: "RATIO";
		/** Measure name of the numerator, which must itself be declared. */
		readonly numerator: string;
		/** Measure name of the denominator, which must itself be declared. */
		readonly denominator: string;
		/** Multiplier applied after the division — 100 for a percentage. */
		readonly scale: number;
		readonly reason: string;
	}
	| { readonly kind: "NON_ADDITIVE"; readonly reason: string };

/**
 * The value a measure carries.
 *
 * A money value is inseparable from the currency key on its returned row. A
 * projection must preserve that key and must refuse to add money from rows with
 * different currencies. Readers perform decimal aggregation in PostgreSQL and
 * expose the completed value as a JavaScript number. Measures that omit this
 * field are ordinary numbers; the optional default keeps declarations written
 * before the first money reader concise while making every money measure explicit.
 */
export type CanonicalMeasureValue =
	| { readonly kind: "NUMBER" }
	| {
		readonly kind: "MONEY";
		/**
		 * Key column whose value names the currency the amount is actually in.
		 * The reader adds this column to the base level key whenever the result
		 * includes this measure. A number-only projection therefore keeps the
		 * level's ordinary key, while a money projection cannot combine currencies.
		 */
		readonly currencyKey: "currency";
	};

export interface CanonicalMeasure {
	readonly name: string;
	readonly description: string;
	readonly additivity: CanonicalAdditivity;
	/** Absent means `{ kind: "NUMBER" }`. Money measures must declare themselves. */
	readonly value?: CanonicalMeasureValue;
	/**
	 * Key of the declared source this measure comes from. A measure that exists
	 * in more than one source is declared once per source.
	 */
	readonly source: string;
}

/**
 * A relation the reader needs, and what to say when the database does not have
 * it.
 *
 * View provisioning is a separate step from table provisioning, and tenant
 * databases run at different schema versions, so "this relation is absent" is a
 * normal answer rather than an exception. A reader reports it and continues with
 * the levels it can still serve — see {@link CanonicalUnavailability}.
 */
interface CanonicalSourceBase {
	/** Short key the levels and measures refer to. */
	readonly key: string;
	/** Relation name in the tenant schema. */
	readonly relation: string;
	/** The relation's own grain, as a named tuple. */
	readonly grain: readonly string[];
	/** What to report when the relation is absent. */
	readonly whenAbsent: string;
	/** Which levels require this relation, whether it supplies facts or lookup values. */
	readonly requiredByLevels: readonly CanonicalLevel[];
}

/** A relation whose rows supply measures and are aggregated by the reader. */
export interface CanonicalFactSource extends CanonicalSourceBase {
	readonly role: "FACT";
	/** Levels this source serves. */
	readonly serves: readonly CanonicalLevel[];
	/**
	 * The level at which a request reads this source's rows one-for-one, with no
	 * aggregation across the key. Named explicitly rather than inferred from the
	 * end of `serves`, because it is what decides whether a `NON_ADDITIVE`
	 * measure has a defined value.
	 */
	readonly sourceGrainLevel?: CanonicalLevel;
}

/** A relation joined only to resolve keys, filters, currency or other lookup values. */
export interface CanonicalDimensionSource extends CanonicalSourceBase {
	readonly role: "DIMENSION";
}

/**
 * One database relation used by a reader.
 *
 * The distinction prevents lookup relations from inventing a
 * `sourceGrainLevel`. Only a fact relation has a level at which its measures are
 * read one row at a time.
 */
export type CanonicalSource = CanonicalFactSource | CanonicalDimensionSource;

export interface CanonicalLevelSpec {
	readonly level: CanonicalLevel;
	/**
	 * The stable entity columns that identify a row at this level, in output order.
	 * A selected money measure adds its declared currency key through
	 * {@link keyColumnsForMeasures}; it is not repeated in every level here.
	 *
	 * This is where the parent-ASIN rule is expressed rather than commented:
	 * `PARENT_ASIN` lists `marketplaceId` and `ASIN` does not.
	 */
	readonly keyColumns: readonly string[];
	/** Key of the declared source that serves this level. */
	readonly source: string;
	readonly note?: string;
}

export interface CanonicalFilter {
	readonly name: string;
	readonly description: string;
	readonly required: boolean;
}

/**
 * Something true about the numbers that a consumer has to be told, attached to
 * the levels it applies to.
 *
 * A caveat is part of the declaration, not a comment in the source, because a
 * projection has to be able to carry it to the consumer. `code` is stable so a
 * projection can key on it — render it as a footnote, a tooltip, or a GraphQL
 * field — without matching on prose.
 */
export interface CanonicalCaveat {
	readonly code: string;
	readonly statement: string;
	readonly appliesToLevels: readonly CanonicalLevel[];
}

export interface CanonicalDeclaration {
	readonly name: string;
	readonly description: string;
	/** The finest grain the reader can report, as a named tuple. */
	readonly grain: readonly string[];
	readonly sources: readonly CanonicalSource[];
	readonly levels: readonly CanonicalLevelSpec[];
	readonly timeGranularities: readonly CanonicalTimeGranularity[];
	readonly measures: readonly CanonicalMeasure[];
	readonly filters: readonly CanonicalFilter[];
	readonly caveats: readonly CanonicalCaveat[];
}

/** A level the request asked for that this database cannot serve, and why. */
export interface CanonicalUnavailability {
	readonly level: CanonicalLevel;
	readonly source: string;
	readonly relation: string;
	readonly reason: string;
}

/** The declared level spec, or `undefined` when the reader does not offer it. */
export function levelSpec(
	declaration: CanonicalDeclaration,
	level: CanonicalLevel,
): CanonicalLevelSpec | undefined {
	return declaration.levels.find((candidate) => candidate.level === level);
}

/** The caveats in force for one level. */
export function caveatsForLevel(
	declaration: CanonicalDeclaration,
	level: CanonicalLevel,
): readonly CanonicalCaveat[] {
	return declaration.caveats.filter((caveat) => caveat.appliesToLevels.includes(level));
}

/**
 * The measures a projection may expose at `level`, given the source serving it.
 *
 * A `NON_ADDITIVE` measure survives only when the requested level IS the source
 * grain, which is the whole enforcement this classification exists for: without
 * it, `buyBoxPercentage` appears as a summable column on an ASIN roll-up and
 * every value in it is meaningless.
 */
export function measuresForLevel(
	declaration: CanonicalDeclaration,
	level: CanonicalLevel,
): readonly CanonicalMeasure[] {
	const spec = levelSpec(declaration, level);
	if (spec === undefined) {
		return [];
	}
	const source = declaration.sources.find((candidate) => candidate.key === spec.source);
	const isSourceGrain = source?.role === "FACT" && source.sourceGrainLevel === level;
	return declaration.measures.filter((measure) => {
		if (measure.source !== spec.source) {
			return false;
		}
		return measure.additivity.kind !== "NON_ADDITIVE" || isSourceGrain;
	});
}

/**
 * The output key for a concrete measure selection.
 *
 * A level declares its stable entity key. Money contributes its currency key
 * only when selected, because forcing currency onto number-only results would
 * split an otherwise valid cross-marketplace ASIN aggregate. The value
 * declaration is therefore also the authority for this conditional key.
 */
export function keyColumnsForMeasures(
	spec: CanonicalLevelSpec,
	measures: readonly CanonicalMeasure[],
): readonly string[] {
	const columns = [...spec.keyColumns];
	for (const measure of measures) {
		if (measure.value?.kind === "MONEY" && !columns.includes(measure.value.currencyKey)) {
			columns.push(measure.value.currencyKey);
		}
	}
	return columns;
}
