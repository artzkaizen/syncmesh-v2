export type { AllowBlock, CompareOp, Operation, PolicyNode } from "./ast.js";
export {
  all,
  allow,
  any,
  claimEquals,
  claimHas,
  claimIncludes,
  deny,
  gt,
  gte,
  isIn,
  lt,
  lte,
  ne,
  not,
  owner,
  patchOnly,
  resolveAllow,
  role,
  rowIs,
} from "./ast.js";
export type { PolicyContext, PolicyGrant, RoleSet } from "./evaluate.js";
export type { ScalarKind } from "./evaluate.js";
export { NO_ROLES, claimAt, evaluate, roleAtLeast, scalarKindOf } from "./evaluate.js";
export type { PolicyDoc } from "./doc.js";
export { MalformedPolicy, parsePolicyDoc } from "./doc.js";
