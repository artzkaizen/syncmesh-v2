import { eslintCompatPlugin } from "@oxlint/plugins";

import { noFloatingResultRule } from "./rules/no-floating-result.ts";
import { noLengthAgainstLimitRule } from "./rules/no-length-against-limit.ts";
import { noRenderedLengthRule } from "./rules/no-rendered-length.ts";

/** Oxlint rules for the conventions this repository decided on, alongside the generic anti-slop set. */
const syncmeshPlugin = eslintCompatPlugin({
	meta: { name: "syncmesh" },
	rules: {
		"no-floating-result": noFloatingResultRule,
		"no-length-against-limit": noLengthAgainstLimitRule,
		"no-rendered-length": noRenderedLengthRule,
	},
});

export default syncmeshPlugin;
