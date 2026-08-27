import type { ColumnName, TableName } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { Result } from "@syncmesh/result";

import type { ValidationError } from "./errors.js";
import type { ProbeEvent, RowLookup, ValidatorOptions } from "./validate.js";

import { moment, revocationKey } from "./authority.js";
import { GrantDeviceMismatch, GrantRevoked, NoGrant } from "./errors.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the reserved revocation table's own name and column */
const REVOCATIONS_TABLE = "_revocations" as TableName;
const AT_COLUMN = "at" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/**
 * Who is writing, and whether they may still write at all: a grant held, naming this device, and
 * not withdrawn since it was issued. The first three rungs of the ladder, together because they
 * are one question — `null` is ungranted mode, where nobody is asked.
 */
export function checkAuthor(
  event: ProbeEvent,
  grantFor: ValidatorOptions["grantFor"],
  row: RowLookup,
): Result<Grant | undefined, ValidationError> {
  if (grantFor === null) return Result.ok(undefined);
  const grant = grantFor(event.peerId);
  if (grant === undefined)
    return Result.err(
      new NoGrant({ peer: event.peerId, message: "no grant held for this author" }),
    );
  if (grant.device !== event.peerId) {
    return Result.err(
      new GrantDeviceMismatch({
        peer: event.peerId,
        device: grant.device,
        message: "the grant names another device",
      }),
    );
  }
  const revoked = checkRevoked(event, grant, row);
  return revoked.isErr() ? revoked : Result.ok(grant);
}

/**
 * Whether this device's powers were withdrawn in the instance it is writing to (RFC-0016). The
 * revocation is an ordinary synced row, so this rung asks the state the validator was already
 * given — a device that has folded it refuses its own next write, and every peer that has
 * folded it refuses that device's writes too.
 *
 * Two comparisons, and both are what keep peers agreeing rather than merely refusing.
 *
 * **Against the grant's `issuedAt`.** A revocation withdraws the grants that existed when it was
 * written and says nothing about later ones, so re-issuing readmits a device with no second verb
 * to call and nothing to unwind.
 *
 * **Against the event's own stamp.** What the device wrote *before* the revocation stands. A
 * revocation that reached back would make the verdict depend on fold order — a peer that folded
 * the write first would keep it, a peer that folded the revocation first would refuse it, and
 * the two would never agree again. Judging the event by when it was written instead means every
 * peer holding both facts reaches the same answer. The residual window is the one RFC-0016 calls
 * honest: a peer that has not yet heard of the revocation admits a later write, until it does.
 */
function checkRevoked(
  event: ProbeEvent,
  grant: Grant,
  row: RowLookup,
): Result<void, ValidationError> {
  if (event.partition === undefined) return Result.ok(undefined);
  const record = row(REVOCATIONS_TABLE, revocationKey(event.partition, event.peerId));
  if (record === undefined) return Result.ok(undefined);
  const at = moment(record.get(AT_COLUMN));
  if (grant.issuedAt.epochMilliseconds > at) return Result.ok(undefined);
  // a probe has no stamp, so it is happening now, which is after any revocation already folded
  if (event.hlc !== undefined && event.hlc[0].epochMilliseconds < at) return Result.ok(undefined);
  return Result.err(
    new GrantRevoked({
      peer: event.peerId,
      partition: String(event.partition),
      message: `this device was revoked from ${String(event.partition)}`,
    }),
  );
}
