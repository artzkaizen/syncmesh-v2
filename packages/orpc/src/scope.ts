/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- this reads the *unvalidated* call input on purpose: the replica has to be chosen before the handler that owns the schema can run, so there is no parsed domain type to accept here yet. Nothing is trusted from it — a scope id is a claim checked by every peer that folds the event (ch. 3), and a field that is not a string is simply not a scope */

import type { MeshSchema } from "@syncmesh/client";

/**
 * Which replica a call is about, read out of the call's own input.
 *
 * **Scope is input, never construction** (book ch. 3). A client is constructed once and knows no
 * tenant, workspace or shop: binding one at construction is rejected outright, because a scope id
 * is ordinary data and data changes without reconstruction. The shape the book keeps passes the
 * scope with every call — `client.products.list({ shopId })` — and this is the function that
 * reads it back out.
 *
 * The rule is the schema's own vocabulary and nothing invented beside it. A table declares
 * `partition: "shop"`, so a call that is about a shop carries `shopId`, and the replica is
 * `shop:<that value>`. Nothing is registered, nothing is configured, and a procedure that names
 * no scope is about the global tables — which is the honest reading, not a default.
 *
 * **A scope id in an input is a claim, never a capability.** Naming a shop grants nothing: every
 * peer that folds the resulting event checks the claim against the author's grants and the
 * schema's rules. That is exactly why scope may travel in an input at all.
 */

/** `shop` → `shopId`: the field a caller puts a scope in, spelled the way the column is. */
const fieldFor = (kind: string): string => `${kind}Id`;

/**
 * Every partition kind the app's own tables actually live in.
 *
 * Read off the entries rather than the kind tree, because the tree declares what *may* exist and
 * the entries say what a call could be about. A kind nothing is stored in can never be the scope
 * of a read or a write.
 */
export const scopeKinds = (schema: MeshSchema): readonly string[] => [
  ...new Set(schema.entries.map((entry) => entry.partition)),
];

/**
 * The partition key this input names, or `undefined` for a call about global tables.
 *
 * Two scopes in one input is a caller asking for two replicas in one transaction, which is not a
 * thing a write can be; it is refused here rather than silently resolved to whichever kind the
 * schema happened to list first.
 */
export const scopeOf = (kinds: readonly string[], input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  // SAFETY: narrowed to a non-null object above; every read below is guarded by its own
  // string check, so a field of any other shape simply does not name a scope
  const fields = input as Record<string, unknown>;
  const named = kinds.filter((kind) => typeof fields[fieldFor(kind)] === "string");
  const [only, second] = named;
  if (second !== undefined)
    throw new Error(
      `this call names two scopes (${named.map(fieldFor).join(", ")}): one call is about one replica`,
    );
  if (only === undefined) return undefined;
  return `${only}:${String(fields[fieldFor(only)])}`;
};

/**
 * The replica a call is about, as one function a caller can hold.
 *
 * The scope-reading stays behind this boundary so nothing outside has to take a raw `unknown`
 * just to route a call: a caller hands over how to open a replica, and gets back something it
 * can pass straight to a gate.
 */
export const replicaFor = <H>(
  schema: MeshSchema,
  open: (scope: string | undefined) => H,
): ((input: unknown) => H) => {
  const kinds = scopeKinds(schema);
  return (input) => open(scopeOf(kinds, input));
};
