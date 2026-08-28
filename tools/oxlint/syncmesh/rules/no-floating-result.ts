import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/** Modules that hand out the `Result` API; an import from either one binds it locally. */
const RESULT_MODULES = new Set(["@syncmesh/result", "better-result"]);

/** Named imports that build a `Result` directly, under whatever local name they are bound to. */
const RESULT_CONSTRUCTORS = new Set(["ok", "err", "Ok", "Err"]);

/** Statics on `Result` that hand back another `Result` instead of folding one away. */
const NAMESPACE_PRODUCERS = new Set([
	"all",
	"allAsync",
	"andThen",
	"andThenAsync",
	"err",
	"flatten",
	"gen",
	"map",
	"mapError",
	"ok",
	"tap",
	"tapAsync",
	"tapBoth",
	"tapBothAsync",
	"tapError",
	"tapErrorAsync",
	"try",
	"tryPromise",
	"tryRecover",
	"tryRecoverAsync",
]);

/** Methods that carry the `Result` down the chain; every other method ends it. */
const CHAIN_PRODUCERS = new Set([
	"andThen",
	"andThenAsync",
	"map",
	"mapError",
	"tap",
	"tapAsync",
	"tapBoth",
	"tapBothAsync",
	"tapError",
	"tapErrorAsync",
	"tryRecover",
	"tryRecoverAsync",
]);

/** Type names that make a return annotation a `Result`-returning one. */
const RESULT_TYPE_NAMES = new Set(["AsyncResult", "Err", "Ok", "Result"]);

/** Wrappers that pass a value through unchanged, so the `Result` under them is still discarded. */
function unwrapPassthrough(node: ESTree.Node): ESTree.Node {
	let current = node;
	for (;;) {
		if (current.type === "AwaitExpression") current = current.argument;
		else if (
			current.type === "ParenthesizedExpression" ||
			current.type === "ChainExpression" ||
			current.type === "TSAsExpression" ||
			current.type === "TSSatisfiesExpression" ||
			current.type === "TSNonNullExpression"
		) {
			current = current.expression;
		} else return current;
	}
}

/** The last identifier of a member chain, e.g. `mutate` in `a.engine.mutate`. */
function propertyName(node: ESTree.Node): string | undefined {
	if (node.type !== "MemberExpression" || node.computed) return undefined;
	return node.property.type === "Identifier" ? node.property.name : undefined;
}

/** `engine.mutate` for both `engine.mutate(…)` and `a.engine.mutate(…)`; the receiver disambiguates. */
function qualifiedName(callee: ESTree.Node): string | undefined {
	const method = propertyName(callee);
	if (method === undefined || callee.type !== "MemberExpression") return undefined;
	const receiver = callee.object;
	if (receiver.type === "Identifier") return `${receiver.name}.${method}`;
	const outer = propertyName(receiver);
	return outer === undefined ? undefined : `${outer}.${method}`;
}

/** Reads `Result`, `Promise<Result<…>>` or a union containing one out of a type annotation. */
function annotationYieldsResult(node: ESTree.Node | null | undefined): boolean {
	if (node === null || node === undefined) return false;
	if (node.type === "TSUnionType") return node.types.some(annotationYieldsResult);
	if (node.type !== "TSTypeReference") return false;
	const head = node.typeName.type === "Identifier" ? node.typeName.name : undefined;
	if (head === undefined) return false;
	if (RESULT_TYPE_NAMES.has(head)) return true;
	if (head !== "Promise") return false;
	return (node.typeArguments?.params ?? []).some(annotationYieldsResult);
}

/** The declared return type of a function-shaped node, if it carries one. */
function returnsResult(node: ESTree.Node): boolean {
	if (
		node.type !== "FunctionDeclaration" &&
		node.type !== "FunctionExpression" &&
		node.type !== "ArrowFunctionExpression"
	) {
		return false;
	}
	return annotationYieldsResult(node.returnType?.typeAnnotation);
}

export const noFloatingResultRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow discarding a `Result`, which turns a failure the type system asked you to handle into silence.",
		},
		messages: {
			floating:
				"This `Result` is discarded, so the error it carries becomes silence. Bind it, return it, `yield*` it, or branch on `isErr()`.",
			voided:
				"`void` drops the `Result` this call carries, not just its promise. An ignored failure has to be an explicit branch, not a keyword.",
		},
		schema: [
			{
				type: "object",
				properties: {
					callees: { type: "array", items: { type: "string" } },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ callees: [] }],
	},
	createOnce(context) {
		/** Local names bound to the `Result` namespace import, e.g. `Result` and `R`. */
		const namespaces = new Set<string>();
		/** Local names bound to `ok` / `err` / `Ok` / `Err`. */
		const constructors = new Set<string>();
		/** Functions declared in this file whose annotation says they return a `Result`. */
		const localFunctions = new Set<string>();
		/** The configured `callees`, re-read per file because overrides can change them. */
		let configured: ReadonlySet<string> = new Set();

		function readOption(): ReadonlySet<string> {
			const option = context.options?.[0];
			if (typeof option !== "object" || option === null || Array.isArray(option)) return new Set();
			const callees = option.callees;
			if (!Array.isArray(callees)) return new Set();
			return new Set(callees.filter((name) => typeof name === "string"));
		}

		function collectImport(local: string, definition: ESTree.Definition): void {
			const specifier = definition.node;
			if (specifier.type !== "ImportSpecifier") return;
			const declaration = specifier.parent;
			if (declaration.type !== "ImportDeclaration") return;
			if (!RESULT_MODULES.has(String(declaration.source.value))) return;
			const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : "";
			if (imported === "Result") namespaces.add(local);
			else if (RESULT_CONSTRUCTORS.has(imported)) constructors.add(local);
		}

		/**
		 * Drops any name a nested scope redeclares. The rule matches a callee by name, and a local
		 * `ok` is not the imported one; forgetting the name reports nothing rather than the wrong thing.
		 */
		function forgetShadowed(moduleScope: ESTree.Scope): void {
			for (const scope of context.sourceCode.scopeManager.scopes) {
				if (scope === moduleScope) continue;
				for (const variable of scope.variables) {
					namespaces.delete(variable.name);
					constructors.delete(variable.name);
					localFunctions.delete(variable.name);
				}
			}
		}

		/**
		 * Reads the file's module scope rather than its statements, so a call written above the
		 * `function` it names still resolves.
		 */
		function collect(): void {
			const scopes = context.sourceCode.scopeManager.scopes;
			const moduleScope = scopes.find((scope) => scope.type === "module") ?? scopes[0];
			for (const variable of moduleScope?.variables ?? []) {
				for (const definition of variable.defs) {
					if (definition.type === "ImportBinding") collectImport(variable.name, definition);
					else if (definition.type === "FunctionName" && returnsResult(definition.node)) {
						localFunctions.add(variable.name);
					} else if (
						definition.type === "Variable" &&
						definition.node.type === "VariableDeclarator" &&
						definition.node.init !== null &&
						returnsResult(definition.node.init)
					) {
						localFunctions.add(variable.name);
					}
				}
			}
			if (moduleScope !== undefined) forgetShadowed(moduleScope);
		}

		function isResultCall(node: ESTree.Node, callees: ReadonlySet<string>): boolean {
			const call = unwrapPassthrough(node);
			if (call.type !== "CallExpression") return false;
			const callee = unwrapPassthrough(call.callee);
			if (callee.type === "Identifier") {
				return (
					constructors.has(callee.name) ||
					localFunctions.has(callee.name) ||
					callees.has(callee.name)
				);
			}
			const method = propertyName(callee);
			if (method === undefined || callee.type !== "MemberExpression") return false;
			const qualified = qualifiedName(callee);
			if (qualified !== undefined && callees.has(qualified)) return true;
			if (callees.has(method) && callee.object.type === "Identifier") return true;
			if (callee.object.type === "Identifier" && namespaces.has(callee.object.name)) {
				return NAMESPACE_PRODUCERS.has(method);
			}
			return CHAIN_PRODUCERS.has(method) && isResultCall(callee.object, callees);
		}

		function check(node: ESTree.Node, expression: ESTree.Node, messageId: "floating" | "voided"): void {
			if (isResultCall(expression, configured)) context.report({ node, messageId });
		}

		return {
			Program() {
				namespaces.clear();
				constructors.clear();
				localFunctions.clear();
				configured = readOption();
				collect();
			},
			ExpressionStatement(node) {
				// A comma expression discards every operand but the last; `SequenceExpression` takes those.
				const discarded =
					node.expression.type === "SequenceExpression"
						? node.expression.expressions.at(-1)
						: node.expression;
				if (discarded !== undefined) check(node, discarded, "floating");
			},
			SequenceExpression(node) {
				for (const operand of node.expressions.slice(0, -1)) check(operand, operand, "floating");
			},
			UnaryExpression(node) {
				if (node.operator === "void") check(node, node.argument, "voided");
			},
		};
	},
});
