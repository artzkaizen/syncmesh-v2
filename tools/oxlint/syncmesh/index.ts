import { eslintCompatPlugin } from "@oxlint/plugins";

import { noFloatingResultRule } from "./rules/no-floating-result.ts";

/** Oxlint rules for the conventions this repository decided on, alongside the generic anti-slop set. */
const syncmeshPlugin = eslintCompatPlugin({
	meta: { name: "syncmesh" },
	rules: {
		"no-floating-result": noFloatingResultRule,
	},
});

export default syncmeshPlugin;
