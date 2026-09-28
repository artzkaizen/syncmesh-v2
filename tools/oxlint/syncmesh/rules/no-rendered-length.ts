import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * An array's length rendered as a number is a claim about the data made by the viewport.
 *
 * Every read on a device is a page of something: a `limit`, a window per status, or a partition
 * that this device holds and the next one does not. So `rows.length` answers "how many am I
 * drawing", and putting it on screen answers "how many are there" — two different questions, and
 * nobody notices they have been swapped until the number changes while somebody is reading it.
 *
 * This repository has already shipped both halves of that. A status badge drawn from
 * `group.rows.length` sat at 0 forever, because the query that filled the list excluded the rows
 * it was counting. And a filtered list capped at 500 would have shown 500 and then jumped, the
 * way every partially-replicated tracker does once. The fix in both cases was the same: count
 * with a second read that has no `LIMIT`, and carry the result as `Counted` so that a number
 * which might still grow renders as `500+` rather than as `500`.
 *
 * A **guard** is not a count and is not reported: `rows.length > 0 ? … : …` and
 * `rows.length === 0 && <Empty/>` ask whether anything is here, which a page can answer honestly.
 * Only a length that reaches the screen as a number is.
 *
 * Nor is every array a page. Without type information this cannot tell a query's rows from a
 * list of transports assembled in memory, so it goes by the name the value is held under —
 * {@link READ_RESULTS}, extended per project through `names`. That is narrow on purpose: it
 * catches `group.rows.length`, which is the bug this was written from, and stays silent on
 * `mediums.length` and `comments.length`, which were the only other hits in this repository and
 * were both correct. A rule that cried wolf on those is a rule somebody turns off.
 */

/** Names a paged read's rows are held under here. Anything else is assumed fully known. */
const READ_RESULTS = new Set(["rows", "data", "results", "page"]);

/** The name a `.length` is taken off — `rows` in `group.rows.length`. */
function heldAs(object: ESTree.Node): string | undefined {
	if (object.type === "Identifier") return object.name;
	if (object.type === "MemberExpression" && !object.computed && object.property.type === "Identifier")
		return object.property.name;
	return undefined;
}

/** `x.length`, through the wrappers that pass a value along unchanged. */
function lengthAccess(node: ESTree.Node, names: ReadonlySet<string>): boolean {
	let current = node;
	for (;;) {
		if (
			current.type === "ParenthesizedExpression" ||
			current.type === "TSAsExpression" ||
			current.type === "TSSatisfiesExpression" ||
			current.type === "TSNonNullExpression"
		) {
			current = current.expression;
			continue;
		}
		if (
			current.type !== "MemberExpression" ||
			current.computed ||
			current.property.type !== "Identifier" ||
			current.property.name !== "length"
		)
			return false;
		const held = heldAs(current.object);
		return held !== undefined && names.has(held);
	}
}

export const noRenderedLengthRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow rendering an array's length as a number, which presents a fact about this page as a fact about the data.",
		},
		messages: {
			rendered:
				"This renders how many rows are drawn, as though it were how many there are. Count with a read that has no `LIMIT` and carry it as `Counted`, so a number that may still grow renders as `500+` rather than as `500`.",
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
		/** Read per file rather than in `createOnce`, where the options are not bound yet. */
		const configured = () =>
			new Set([
				...READ_RESULTS,
				...((context.options?.[0] as { names?: readonly string[] } | undefined)?.names ?? []),
			]);
		const report = (node: ESTree.Node) =>
			context.report({ node, messageId: "rendered" });

		/** A container child, not an attribute value: only what a reader actually sees. */
		const visitChildren = (children: readonly ESTree.Node[]) => {
			const names = configured();
			for (const child of children) {
				if (child.type !== "JSXExpressionContainer") continue;
				const { expression } = child;
				if (lengthAccess(expression, names)) {
					report(expression);
					continue;
				}
				// `{`${rows.length} issues`}` is the same number with a word after it
				if (expression.type === "TemplateLiteral")
					for (const part of expression.expressions)
						if (lengthAccess(part, names)) report(part);
			}
		};

		return {
			JSXElement(node) {
				visitChildren(node.children);
			},
			JSXFragment(node) {
				visitChildren(node.children);
			},
		};
	},
});
