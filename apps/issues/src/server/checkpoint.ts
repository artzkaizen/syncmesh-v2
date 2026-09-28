import type { Engine } from "@syncmesh/engine";
import type { Identity } from "@syncmesh/wire";

import { Temporal } from "@syncmesh/temporal";
import { checkpointHash, encodeRecord, issueCheckpoint } from "@syncmesh/wire";

/**
 * The authority saying, in one signature, which state this is.
 *
 * State arrives at a joining device with no per-event signatures behind it (RFC-0019), so a
 * certificate is the only thing that can make it more than provisional. What it certifies is a
 * hash over the rows and the coverage they fold — which is why it has to be minted from the *same*
 * rows the sender is about to put on the wire.
 *
 * **Why the authority and not the relay.** The certificate is signed with the issuer key, the same
 * root every device already pins in `trust`. The relay holds no opinion about what it carries —
 * custody, not agreement — and in fact holds no state at all: its room keeps the log and never
 * folds it. The authority is the one participant with both the materialized rows and a key, so it
 * is the only one that can honestly say "this is the state".
 */

/**
 * A certificate over this node's state right now, minted fresh on every call.
 *
 * **Deliberately not cached, and that is the whole correctness of it.** `join.ts` serves a
 * snapshot by taking `engine.snapshot()` and then asking for a certificate, with nothing awaited
 * between the two — so a certificate minted in that same turn covers exactly the rows about to be
 * sent. A cached one would cover whatever the state was when it was taken, and every fold in
 * between turns it into a signature for state this node no longer has: the receiver recomputes
 * the hash over what it installed, finds a different answer, and refuses an honest snapshot.
 *
 * Hashing is O(state) and this pays it per request, which is the right trade because a snapshot
 * request is rare — a device asks once, when it holds nothing — while a wrong certificate would
 * be wrong for as long as it was held.
 */
export function certificates(engine: Engine, issuer: Identity): () => Uint8Array {
  return () => {
    const snapshot = engine.snapshot();
    // hashed exactly as the receiving side hashes what it installed, or the two reach different
    // answers over identical rows and every honest snapshot is refused
    const hashed = snapshot.rows.map((row) => ({
      table: String(row.table),
      key: String(row.key),
      record: encodeRecord(row.record),
    }));
    return issueCheckpoint(issuer, {
      stateHash: checkpointHash(hashed),
      coverage: snapshot.coverage.synced,
      now: Temporal.Now.instant(),
    });
  };
}
