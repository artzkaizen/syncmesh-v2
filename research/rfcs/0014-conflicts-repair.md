---
rfc: 0014
title: Conflict Surface, Integrity & Repair
package: syncmesh (src/core/kernel.ts · src/core/engine.ts) — design
layer: 2
status: partial
standalone: false
deps: ["0002", "0003", "0009"]
---

# RFC-0014 — Conflict Surface, Integrity & Repair

## Purpose

When concurrent writes collide: what wins, in every case, and where the loser
goes. When data is broken: how it is detected, contained, healed. Resolution
is built; the conflict *surface* and the repair layers are the proposal.

## 1 · The collision matrix

A conflict is two concurrent events on one row — neither saw the other, else
HLC ordering makes it a plain sequential apply. Outside this matrix = a bug:

| A \ B (concurrent) | `insert` | `update` | `delete` | `crdt` |
|---|---|---|---|---|
| **`insert`** | LWW by `(hlc, peer)`: later insert wins the row; loser → conflict record (§2) | later insert wins, else patch applies on top | later stamp wins (tombstone vs row) | n/a — crdt needs an existing row |
| **`update`** | — | **field-level LWW**: disjoint columns MERGE; same column → later stamp wins, losing value recorded (§2) | later tombstone wins; else the row lives | independent — both apply |
| **`delete`** | — | — | idempotent: keep max stamp | later delete hides the field |
| **`crdt`** | — | — | — | always merge — commutative, no loser |

The kernel (`src/core/kernel.ts`) implements this: per-column `cellStamps`,
row-level `writeStamp`/`deleteStamp`, a row visible iff no delete or
`writeStamp > deleteStamp`. Max-based comparisons — commutative, associative,
idempotent — so delivery order and replay cannot change the outcome. The
`crdt` kind is spec only — absent from the wire (RFC-0002) and the kernel.

## 2 · Losers are preserved, never destroyed

"Lost" and "silently destroyed" are different policies. Proposed: every
losing write lands in a bounded `__syncmesh_conflicts` table — `{ table, key,
column?, losingValue, losingEvent: {id, peer, hlc}, winningHlc, recordedAt }`.

- Bounded: GC'd with tombstones at the compaction floor + per-group cap
  (default 1000, oldest evicted).
- Surfaced (RFC-0009): `row.$conflicts` on live-query rows (one join → an
  "edited on 2 devices" badge), `useConflicts()`, and `restore(conflictId)`.
- **`restore()` is a NEW event with a fresh HLC — never history surgery.** The
  mesh converges on it like any write; merge-both apps use CRDT fields.

## 3 · Beyond LWW: invariants and the authority

LWW cannot express cross-row invariants ("one booking per seat", "unique
usernames") — under partition, devices satisfy them locally, violate jointly:

1. **Design it away** — reservations become append-only claims; the display
   rule (lowest HLC wins the seat, other flagged) is deterministic everywhere.
2. **Deterministic repair rule** — `invariant({ unique: [...], resolve:
   "lowest-hlc-wins" })`: a pure function of converged state, losers → §2.
3. **Authority adjudication** — real stakes (payments, inventory) go through
   server ops, never optimistic, or settle on reconnect.

When the authority rejects an event peers already applied p2p: **rejection =
authoritative overwrite** — a corrective event, server-signed, fresh higher
HLC; LWW does the rest. The rejected effect lands in `__syncmesh_conflicts`
(reason `"rejected"`); the origin gets `event-rejected { id, reason }`. **No
client rollback machinery** — unreachable peers keep the provisional value;
receivers check grants/claims only, never local mutable state (RFC-0008).

## 4 · Broken data: taxonomy, containment, repair

| # | Failure | Detected by | Response | Blast radius |
|---|---|---|---|---|
| B1 | Malformed bytes (truncated frame, bad CBOR) | transport decode | drop frame; retry/ack recovers | none |
| B2 | Bad signature / forged peerId | `verify` before anything | drop + typed `bad-signature` error; penalize route | none — never touches log or state |
| B3 | Schema/policy-invalid change | validation before apply | quarantine | one event |
| B4 | Unknown columns on a known table (newer sender) | apply loop | apply known columns; park unknown in an overflow blob until upgrade | none |
| B5 | Unknown table entirely (newer app) | apply loop | append un-materialized; replay after upgrade | none |
| B6 | Poison event (apply throws) | try/catch around apply | quarantine; the lane continues — never fail-stop | one event |
| B7 | Divergence (same events, different state) | state-hash anti-entropy | targeted row repair | detected + healed |
| B8 | Local corruption (torn write, damaged store) | integrity check + snapshot hash at boot | snapshot re-bootstrap | this device only |
| B9 | Duplicate / replayed delivery | id dedup + per-column stamps | no-op by construction | none |
| B10 | Byzantine authorship (valid key, hostile content) | not detectable by crypto — contained by partitions + claim checks + corrective events | revocation window open | bounded, not eliminated |

Stance: validity checked once at the boundary (B1–B3); version skew is data to keep, not garbage (B4–B5); no single event stops the world (B6).

**Quarantine (proposed shape).** Appended to the log but **not materialized**
— signed provenance; the sender must not resend forever; cursors advance past
it. Retry on upgrade (new `schemaVersion`), `retryQuarantine()`, or a timer.
Bounded per group, loud in stats — growth is the #1 signal of an engine bug.

**State-hash anti-entropy (proposed).** Cursors guarantee everyone *has* the
same events, not that everyone *computed* the same state. A per-`(group,
table)` running digest — XOR/sum of `hash(key ‖ row ‖ stamps)`, O(1) per apply
— piggybacks on the final catch-up chunk; matching digests cost nothing more.
On mismatch: drill down to per-key row hashes, then repair **symmetrically** —
each side runs the §1 apply on the other's `(row, stamps)`: stale rows lose to
the higher-stamp truth, genuine concurrency resolves as a conflict would.
Persistent mismatch = engine bug → loud `divergence-unrepairable`.

**The repair ladder** — one escalation path, each rung bounded:

```
1. dedup                  event.id already folded         free, constant
2. LWW skip               older stamp for a column        free, constant
3. conflict record        concurrent loser preserved      one row
4. quarantine             invalid/poison event parked     one event
5. state-hash repair      divergent rows reconciled       per-row, targeted
6. snapshot re-bootstrap  local state unrecoverable       per-group, staged
```

Rung 6 exists because **a device cannot rebuild from its own log after
compaction** — the tail is gone by design (RFC-0003). Beyond rung 5, repair =
re-fetch state via the snapshot join path: the same code, not a special path.

## Current state

| Piece | State |
|---|---|
| Field-level LWW, tombstones, max-based merge | **built** — `src/core/kernel.ts` |
| B1/B2/B9: typed drops + dedup | **built** — `decodeAndVerify` emits `malformed`/`bad-signature` before log or state; folded-id set + stamps make replay a no-op (tested, `tests/edge-cases.test.ts`) |
| B3 admission | **built as drop-with-typed-reason** — `admit()` rejects, `denied` error surfaces; the event is NOT parked or retried |
| B8 (partial) | **built** for the localStorage store: corrupt log recovers empty AND surfaces a typed error (tested) |
| Conflict records, `$conflicts`, `restore()` | **dropped.** A losing write is gone from STATE but still in the LOG, so `collections.x.history(key)` answers "what did this overwrite?" over data we already keep — more general (the whole sequence, not the last loser), no declaration, nothing until asked. Restoring is writing the value again. `src/core/history.ts` |
| Corrective events + `_corrections` | **built** — `correct(engine, {event, table, key, reason, detail, author, partition}, fix)` writes the overwrite AND its reason as ONE signed event; `_corrections` is deny-all so only the authority bypass admits it. `mesh.corrections.{all,mine,forEvent}`. `tests/corrections.test.ts` |
| State digests + targeted repair (rung 5) | **built** — `engine.digest()`, `rowDigests()`, `divergentTables()`, `divergentRows()`, `rowRecords()`, `repairRows()`. `tests/digest.test.ts` |
| `crdt` kind, invariant rules, corrective events, quarantine parking, state-hash, rungs 5–6 | proposed |
| Insert×insert | honest divergence: the kernel field-merges `insert` columns like `update`, not the matrix's whole-row replace; converges either way — spec and kernel must pick one |

## Remaining work

- Parked quarantine with retry-on-upgrade replacing today's drop-with-reason (needs RFC-0013's evolution block first).
- `event-rejected` notification on the authority — corrections carry the reason as data, but nothing pushes it at the author.
- `crdt` change kind on the wire (RFC-0002) and its kernel merge.
- Piggyback digests on the final catch-up frame — the primitives exist, nothing calls them automatically yet.
- Wire rung 6 (snapshot re-bootstrap) to persistent mismatch.
- Tests: every matrix cell in both delivery orders; fault injection per taxonomy row; divergence heal; re-bootstrap as repair.

## Open questions

- Insert×insert: keep the matrix's whole-row LWW, or bless the kernel's field-merge as the spec?
- B10 revocation window: how long do a revoked key's events stay accepted by offline peers?
- ~~Digest function: XOR of row hashes is order-free but weak to paired flips — sum mod 2^64 instead?~~ **Answered: sum.** XOR is self-cancelling — any two rows hashing alike erase each other and a paired corruption is invisible. Addition mod 2^64 is equally order-free with no such pair. Pinned by a test that duplicating a row must change the digest.
- Should quarantined events live in the event store with a flag, or in a sidecar table?
- Digest scope: a digest covers the rows a peer HOLDS, so peers with different interests (RFC-0019) differ legitimately. Comparing across scopes is meaningless — should the digest carry its interest so a mismatch can be dismissed automatically?
