/**
 * The family label for an ASIN with no family in `brand_config_amazon_asin`.
 *
 * Every canonical reader that groups by family coalesces to this label rather
 * than dropping the row, so a FAMILY roll-up totals to the same measures as the
 * ASIN rows it summarises. Readers, the MCP tools and the Explore loaders all
 * read it from here, because the moment two of them spell it differently a row
 * that exists on one side has no counterpart on the other.
 *
 * It holds no punctuation, because clients expect a family name to contain no
 * special characters.
 */
export const MISSING_FAMILY = "MISSING";
