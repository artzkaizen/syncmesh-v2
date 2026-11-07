import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { GRANDFATHERED } from "../naming-allowlist.ts";

/** camelCase Of/For suffix: `hintOf`, `storeNameFor`. Lowercase English (`before`) never matches. */
const SUFFIX = /(Of|For)$/;

/** Test fixtures collide freely — fixtures are local by design and outside the rule. */
function isTestPath(filename: string): boolean {
  return filename.includes("__tests__/") || filename.includes("fixtures");
}

export const noOfForSuffixRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow new exported *Of/*For helpers; name by product (.agents/skills/naming/SKILL.md).",
    },
    messages: {
      suffixed:
        "New exported helper uses an Of/For suffix. Name by product, not by source — see .agents/skills/naming/SKILL.md (methods for views, verbs for logic, noun-first for pure projections).",
    },
    schema: [],
  },
  createOnce(context) {
    let inScope = false;
    return {
      Program() {
        // filename is per-file state: read it here, not in createOnce.
        inScope = !isTestPath(context.filename);
      },
      FunctionDeclaration(node: ESTree.Node) {
        if (!inScope || node.type !== "FunctionDeclaration") return;
        if (!isExported(node)) return;
        const id = node.id;
        // declaration ids arrive as Identifier at runtime (BindingIdentifier in the types).
        if (id !== null && id.type === "Identifier" && SUFFIX.test(id.name)) {
          if (!GRANDFATHERED.has(id.name)) context.report({ node, messageId: "suffixed" });
        }
      },
      VariableDeclaration(node: ESTree.Node) {
        if (!inScope || node.type !== "VariableDeclaration") return;
        if (!isExported(node)) return;
        for (const declarator of node.declarations) {
          const id = declarator.id;
          if (
            (id.type === "Identifier" || id.type === "BindingIdentifier") &&
            SUFFIX.test(id.name)
          ) {
            if (!GRANDFATHERED.has(id.name)) context.report({ node, messageId: "suffixed" });
          }
        }
      },
    };
  },
});

/** Whether this declaration sits directly under `export ...` (specifier re-exports excluded). */
function isExported(node: ESTree.Node): boolean {
  return (
    "parent" in node &&
    node.parent !== null &&
    typeof node.parent === "object" &&
    "type" in node.parent &&
    (node.parent as { readonly type: string }).type === "ExportNamedDeclaration"
  );
}
