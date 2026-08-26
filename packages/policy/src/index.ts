export type { AllowBlock, Operation, PolicyNode } from "./ast.js";
export {
  allOf,
  allow,
  anyOf,
  claimEquals,
  claimHas,
  claimIncludes,
  deny,
  not,
  owner,
  patchOnly,
  resolveAllow,
  role,
  rowIs,
} from "./ast.js";
export type { PolicyContext, PolicyGrant } from "./evaluate.js";
export type { ScalarKind } from "./evaluate.js";
export { claimAt, evaluate, roleAtLeast, scalarKindOf } from "./evaluate.js";
export type { PolicyDoc } from "./doc.js";
export { MalformedPolicy, parsePolicyDoc } from "./doc.js";
