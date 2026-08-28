import type { AllowBlock, PolicyNode } from "@syncmesh/policy";

import { deny, role } from "@syncmesh/policy";

export interface CdcRules {
  /** Who may read the projection — a rule that reads the row's **columns**; see below. */
  readonly read: PolicyNode;
  /**
   * The role the authority's own grant carries. It is the only writer a CDC-backed collection
   * has, and naming it here is what makes "read-only on devices" a rule the validator enforces
   * rather than a convention the app is trusted to keep. Never issue it to a device: a second
   * writer is the mirror this design exists to refuse.
   */
  readonly writer: string;
}

/**
 * The rules a CDC-backed collection needs: the authority writes it, whoever `read` names reads
 * it, and nothing else is permitted at all. A device write is refused by its own validator
 * before it becomes an event, and quarantined at every peer if one is forged anyway — the same
 * verdict from the same rule in both places, which is what makes the direction real rather than
 * documented.
 *
 * **`owner()` does not work on these tables, and that is why `read` must read the column.** The
 * authority signs every event CDC produces, so `owner("createdBy")` compares the row's column
 * against the *authority's* account and not the person's: the column still holds a user id, but
 * the signature does not. It is false for every real owner and true for none — a rule that
 * looks right and denies everyone. Read the column instead: `rowIs`, `isIn`, `claimHas`,
 * `claimEquals`, or a comparison.
 *
 * ```ts
 * tasks: {
 *   columns,
 *   partition: "org",
 *   allow: ({ rowIs, claimHas }) =>
 *     cdcAllow({ read: claimHas("sites", "siteId"), writer: "system" }),
 * }
 * ```
 */
export const cdcAllow = (rules: CdcRules): AllowBlock => ({
  $default: deny,
  read: rules.read,
  write: role(rules.writer),
});
