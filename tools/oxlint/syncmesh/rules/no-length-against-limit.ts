import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * Comparing a result's length against the limit that produced it is a guess about the store.
 *
 * It reads as though it establishes something — "I asked for 500 and got 500, so there are more"
 * — and it is wrong in both directions. At exactly the limit the two cases are indistinguishable,
 * so a set of exactly 500 reports more to come forever. And the comparison holds two constants in
 * two places: change the limit at the query and not at the check, and this silently reports the
 * opposite of the truth with nothing to show for it.
 *
 * The store ran the query and knows. Ask it — a `complete` flag beside the rows, or a probe row
 * (`limit + 1`, return `limit`) — or subtract two exact reads, which is what a count with no
 * `LIMIT` beside a windowed page already gives you for free.
 *
 * Written after this repository shipped exactly this, `rows.length >= LISTED`, with a comment
 * admitting the boundary was ambiguous instead of removing the ambiguity.
 */

/**
 * The comparisons that guess, and deliberately not `<` or `>`.
 *
 * `length > limit` is the probe done right: ask for one more than you will show, and a strictly
 * greater count is proof there is another row — no ambiguity anywhere, which is why this repo's
 * own `devtools/source/writes.ts` slices to `limit` and tests `> limit`. `length < limit` is
 * proof of the opposite, and just as sound. It is `>=` and the equalities that cannot tell a set
 * of exactly `limit` from a set of more, and only those are reported.
 */
const COMPARISONS = new Set(["<=", ">=", "===", "==", "!==", "!="]);

/** Names that mean "how many I asked for". Extended per project through `names`. */
const LIMITISH = /^(limit|listed|searched|take|top|page_?size|per_?(page|status|group))$/i;

function lengthAccess(node: ESTree.Node): boolean {
	return (
		node.type === "MemberExpression" &&
		!node.computed &&
		node.property.type === "Identifier" &&
		node.property.name === "length"
	);
}

/** The identifier or trailing property a comparison is against — `LISTED`, `opts.limit`. */
function nameOf(node: ESTree.Node): string | undefined {
	if (node.type === "Identifier") return node.name;
	if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier")
		return node.property.name;
	return undefined;
}

export const noLengthAgainstLimitRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow inferring truncation by comparing a result's length to the limit that produced it.",
		},
		messages: {
			inferred:
				"This infers truncation from the page's own length, which is ambiguous at exactly the limit and wrong as soon as the two constants drift. Ask the store whether it truncated, or subtract an unlimited count from the rows you drew.",
		},
		schema: [
			{
				type: "object",
				properties: { names: { type: "array", items: { type: "string" } } },
				additionalProperties: false,
			},
		],
		defaultOptions: [{ names: [] }],
	},
	createOnce(context) {
		return {
			BinaryExpression(node) {
				if (!COMPARISONS.has(node.operator)) return;
				const extra = new Set(
					((context.options?.[0] as { names?: readonly string[] } | undefined)?.names ?? []).map(
						(name) => name.toLowerCase(),
					),
				);
				const against = lengthAccess(node.left)
					? node.right
					: lengthAccess(node.right)
						? node.left
						: undefined;
				if (against === undefined) return;
				const name = nameOf(against);
				if (name === undefined) return;
				if (LIMITISH.test(name) || extra.has(name.toLowerCase()))
					context.report({ node, messageId: "inferred" });
			},
		};
	},
});
