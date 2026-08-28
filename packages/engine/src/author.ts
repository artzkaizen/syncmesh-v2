import type { ColumnName } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { Result } from "@syncmesh/result";
import { RESERVED } from "@syncmesh/schema";

import type { ValidationError } from "./errors.js";
import type { Author, ProbeEvent, RowLookup, StateLookup, ValidatorOptions } from "./validate.js";

import { linkedAuthor } from "./accounts.js";
import { moment, revocationKey } from "./authority.js";
import { GrantDeviceMismatch, GrantRevoked, GrantStale, NoGrant } from "./errors.js";
import { graceMillis } from "./rules.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the reserved revocation table's own name and column */
const AT_COLUMN = "at" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** What deciding an author needs from the validator's options; a `ValidatorOptions` is one. */
export type AuthorOptions = Pick<ValidatorOptions, "grantFor" | "now" | "authority" | "accounts">;

/**
 * Who is writing, and whether they may still write at all: a grant held, naming this device, not
 * withdrawn since it was issued, and recent enough for the instance being written to. The first
 * four rungs of the ladder, together because they are one question.
 *
 * `grantFor: null` is ungranted mode, where none of those four is asked. It is the **only** arm
 * that reads a link, and only where `accounts` is on: a mesh with an issuer already answers
 * `owner()` across a person's devices, because the issuer mints each of their grants with the
 * same `account`. Reading a link there would let a key nobody vetted contradict a configured
 * trust anchor — so it is not out-ranked, it is never read (D21).
 */
export function checkAuthor(
  event: ProbeEvent,
  state: StateLookup,
  options: AuthorOptions,
): Result<Author | undefined, ValidationError> {
  const { grantFor, now, authority } = options;
  if (grantFor === null)
    return Result.ok(options.accounts === true ? linkedAuthor(event, state) : undefined);
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
  const revoked = checkRevoked(event, grant, state.row);
  if (revoked.isErr()) return revoked;
  // the authority is exempt from the window it publishes. It is the peer that writes
  // `_revocations` and `_policy`, so a grace wider than its own remaining validity would lock it
  // out of the instance it governs — unable to revoke a stolen device, and unable to relax the
  // window that is stopping it. Revocation still binds it: that one is a fact about a device,
  // and an authority is not exempt from facts
  if (event.peerId === authority) return Result.ok(grant);
  const stale = checkStale(event, grant, state.row, now);
  return stale.isErr() ? stale : Result.ok(grant);
}

/**
 * Whether the instance being written to still trusted a grant this old *when the event was
 * written* (RFC-0016). The window itself is `graceMillis`, which owns the reasoning for it.
 *
 * **Against the event's own stamp**, for the reason `checkRevoked` gives below: read against the
 * receiving peer's clock instead, the verdict would depend on when a peer happened to validate,
 * so the author would keep a write that every peer receiving it after the boundary quarantined,
 * and the two would never agree again. That is the one failure this feature exists to cause —
 * a device goes dark and syncs its backlog late — so judging by arrival time would lose exactly
 * the legitimate work it is supposed to bound. A stamp is the author's own word, which is the
 * same residual honesty the revocation rung already accepts.
 *
 * Without a clock there is no check at all — the same shape as `grantFor: null` meaning ungranted
 * mode. A validator that cannot say when now is must not start refusing what it admitted before.
 */
function checkStale(
  event: ProbeEvent,
  grant: Grant,
  row: RowLookup,
  now: ValidatorOptions["now"],
): Result<void, ValidationError> {
  if (now === undefined) return Result.ok(undefined);
  const grace = graceMillis(event.partition, row);
  if (grace === undefined) return Result.ok(undefined);
  // a probe has no stamp, so it is happening now, which is the latest this event can have been written
  const at = event.hlc?.[0].epochMilliseconds ?? now().epochMilliseconds;
  if (at + grace < grant.expiresAt.epochMilliseconds) return Result.ok(undefined);
  return Result.err(
    new GrantStale({
      peer: event.peerId,
      expiresAt: grant.expiresAt.toString(),
      message: `this grant is too old for ${String(event.partition)}: renew it`,
    }),
  );
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
  const record = row(RESERVED.revocations, revocationKey(event.partition, event.peerId));
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
