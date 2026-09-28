import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * Authority bodies live under `server/` and must never reach client bundles: a body
 * imported into a screen ships signing-adjacent logic to the device it was withheld
 * from. Files under `app/` (screens, hooks, client entries) therefore must not import
 * modules under a sibling `server/` directory or `*.server.ts` files.
 *
 * The rule keys off paths, not package names, because the split is per-app
 * (`apps/issues/src/app/` vs `apps/issues/src/server/`), not per-package.
 */
function isAppFile(filename: string): boolean {
	return /(^|\/)app\//.test(filename);
}

/** A `server/` directory anywhere in the path, or a `.server` module under any of the extensions an import spells. */
function isServerModule(source: string): boolean {
	return /(^|\/)server\//.test(source) || /\.server(\.[cm]?[jt]sx?)?$/.test(source);
}

export const noServerImportInAppRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow importing server-only modules (authority bodies) from app files, which would ship them to client bundles.",
		},
		messages: {
			serverImport:
				"This imports a server-only module into an app file, so an authority body would ship to the client bundle. Move the shared part to the contract (`*.contract.ts`) or the call behind the authority link.",
		},
		schema: [],
	},
	createOnce(context) {
		let inAppFile = false;
		return {
			Program() {
				// filename is per-file state: read it here, not in createOnce.
				inAppFile = isAppFile(context.filename);
			},
			ImportDeclaration(node: ESTree.Node) {
				if (!inAppFile) return;
				if (node.type !== "ImportDeclaration") return;
				const source = node.source;
				if (source.type !== "Literal" || typeof source.value !== "string") return;
				// type-only imports carry no runtime body — the mirror type is meant to be shared.
				if (node.importKind === "type") return;
				if (isServerModule(source.value)) context.report({ node, messageId: "serverImport" });
			},
		};
	},
});
