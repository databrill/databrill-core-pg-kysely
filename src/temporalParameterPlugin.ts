import type {
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	PrimitiveValueListNode,
	QueryResult,
	RootOperationNode,
	UnknownRow,
	ValueNode,
} from "kysely";
import { OperationNodeTransformer } from "kysely";
import { isTemporalValue, temporalToPostgres } from "./temporalValues.ts";

/**
 * Converts Temporal values in query PARAMETERS to the text Postgres expects.
 *
 * The read path is handled by driver type parsers, but the write path has no
 * equivalent hook: `pg` serializes an unrecognized object with
 * `JSON.stringify`, which for a Temporal value yields a quoted ISO string
 * (`"2026-08-10T19:18:27.361Z"`, quotes and all) that Postgres rejects. Since
 * the published insert and update types accept Temporal values, something has
 * to render them, and the query-parameter layer is the only place that sees
 * every one of them — inserts, updates, `where` comparisons, `in` lists, and
 * values nested inside expressions alike.
 *
 * Installed automatically by `createDb()`. Exported for callers who build their
 * own Kysely instance against these types.
 *
 * `ValueNode` and `PrimitiveValueListNode` are the only two node kinds that
 * carry a bound parameter in Kysely 0.29, so covering both covers every
 * parameter — including ones inside a raw `sql` fragment, which land in a
 * `RawNode`'s parameters as ordinary `ValueNode`s.
 */
export const temporalParameterPlugin: KyselyPlugin = {
	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		return transformer.transformNode(args.node, args.queryId);
	},
	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		// Nothing to do: the driver's type parsers already produced Temporal
		// values, so rows arrive in their published shape.
		return Promise.resolve(args.result);
	},
};

/**
 * Rewrites the two node kinds that carry literal parameter values.
 *
 * Nodes are rebuilt by spread rather than through the `ValueNode.create`
 * factories, which Kysely marks `@internal`; spreading preserves every field
 * (including `immediate`) without depending on an unstable surface.
 */
class TemporalParameterTransformer extends OperationNodeTransformer {
	protected override transformValue(node: ValueNode): ValueNode {
		const transformed = super.transformValue(node);
		// Tested with `needsRender`, not `isTemporalValue`, because a single
		// ValueNode can hold a JS ARRAY of Temporal values — that is what
		// `col = ANY($1)` compiles to, and it is how callers avoid an `in` list
		// with thousands of entries. Checking the array object itself would find
		// nothing and let every element through unrendered.
		if (!needsRender(transformed.value)) {
			return transformed;
		}
		return { ...transformed, value: temporalToPostgres(transformed.value) };
	}

	protected override transformPrimitiveValueList(node: PrimitiveValueListNode): PrimitiveValueListNode {
		const transformed = super.transformPrimitiveValueList(node);
		if (!transformed.values.some(needsRender)) {
			return transformed;
		}
		return { ...transformed, values: transformed.values.map(temporalToPostgres) };
	}
}

/** One instance: the transformer is stateless, so sharing it is free. */
const transformer = new TemporalParameterTransformer();

/** A Temporal value, or an array holding one at any depth. */
function needsRender(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some(needsRender);
	}
	return isTemporalValue(value);
}
