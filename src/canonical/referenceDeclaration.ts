import type { CanonicalFilter } from "./declaration.ts";

/** One output field of a canonical reference reader. */
export interface CanonicalReferenceField {
	readonly name: string;
	readonly sourceColumn: string;
	readonly description: string;
	readonly nullable: boolean;
}

/** The one relation a direct reference reader selects from. */
export interface CanonicalReferenceSource {
	readonly relation: string;
	readonly whenAbsent: string;
}

/**
 * Declaration for a direct lookup entity with no measures or time axis.
 *
 * AmazonMarketplace and AmazonCountry are conceptual tables, but they are not
 * aggregate facts. This shape states their grain, fields and filters without
 * inventing group-by levels or time granularities that they do not have.
 */
export interface CanonicalReferenceDeclaration {
	readonly name: string;
	readonly description: string;
	readonly grain: readonly string[];
	readonly source: CanonicalReferenceSource;
	readonly fields: readonly CanonicalReferenceField[];
	readonly filters: readonly CanonicalFilter[];
}

/** Why a reference reader returned no rows because its relation is absent. */
export interface CanonicalReferenceUnavailability {
	readonly relation: string;
	readonly reason: string;
}
