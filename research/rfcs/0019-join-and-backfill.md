---
rfc: 0019
title: Join, Snapshots & Backfill
package: syncmesh (src/core/engine.ts · server) — design + partial
layer: 2
status: partial
standalone: false
deps: ["0002", "0004", "0008", "0010", "0015", "0018"]
---

# RFC-0019 — Join, Snapshots & Backfill

## The problem, measured

A device joining a workspace by replaying its event log does not scale. This
is not a projection; it is what `bench/load/` records on a real multi-process
run at 1,000,000 events:

| | measured |
|---|---|
| events to transfer | 1,012,500 |
| signed wire payload | **319 MB** (315 B/event) |
| time to join over a LAN relay | **> 20 minutes** (cut off by the harness) |
| sustained join rate | ~761 events/s, bottlenecked on per-event Ed25519 |
| resulting state | 820,582 rows |
| log on disk | 1.87 GB per device |

Over BLE at 250 kbps the same join is **2.8 hours** of radio time. A phone
that wants to show fifty rows does not need any of it.

Three separate reductions are available, and they multiply.

## 1 · Ship state, not history

The log answers *what happened*. A joining device needs *what is true now*.
Those are different sizes and the gap widens with age: this workspace folds
1,012,500 events into 820,582 rows, and a mature one folds far harder,
because every edit to a row is another event but not another row.

More importantly, a snapshot changes the **verification** cost. Replaying
costs one signature check per event. A snapshot is one artifact.

## 2 · Ship only the scope the device belongs to

Partitions already exist (RFC-0008) and interest predicates already exist
(RFC-0018). A device in 2 of 8 teams needs roughly a quarter of the rows. It
should never see the rest — not as an optimization, but because it has no
business holding them.

## 3 · Ship only the window the device can show

Even inside its own team, a device renders a screen: the newest N issues, the
last N messages. Older rows are *backfilled on demand* when the user scrolls,
or never. This is the reduction that turns megabytes into kilobytes, because
it is bounded by the viewport rather than by the workspace.

## The join, concretely

```
client → server   JOIN { interest, window, cursors }
server → client   SNAPSHOT { rows(+stamps), cursors, heads[] }   (paged)
server → client   …live tail from `cursors` onward, as normal events
later:
client → server   BACKFILL { partition, table, before: key|time, limit }
server → client   SNAPSHOT { rows, cursors }                     (paged)
```

Four properties make this safe rather than merely small:

**Rows carry their stamps.** A snapshot row is `{cells, cellStamps,
writeStamp, deleteStamp}` — the same `RowRecord` the kernel folds to. The
receiver **merges** it (`kernel.mergeRecord`) instead of replacing state, so
LWW still decides every cell. Consequences, all tested
(`tests/scoped-join.test.ts`): a newer local edit survives an older snapshot;
two overlapping partial snapshots commute; installing one never discards data
the device already had.

**Tombstones travel.** A deleted row is included even when it no longer
matches the interest. Omitting it would leave the joiner displaying a row its
author deleted — the one case where "you don't need this" is wrong.

**The receiver adopts the cursors.** The snapshot states which events are
already folded into it; the joiner sets its cursors there and never fetches
that history. That is the entire saving — and the entire risk: **a snapshot
must be complete for its scope**, or the missing rows are missing forever,
because cursors say they were delivered.

**Widening the scope resets the cursors.** Exactly as with interest
predicates (RFC-0018): a max-based cursor cannot describe the holes that
scoping left, so a device that joins a third team must re-request rather than
assume. Narrowing is free.

## Measured effect

`bench/join.ts` compares the four strategies against one workspace. Byte
counts are exact; apply times are on a relay-speed link.

Measured by `bun bench/join.ts` on a 60,000-event workspace (30,000 rows,
8 teams). Snapshots are in the compact encoding below; both columns are the
same workspace:

| join strategy | units | raw | gzipped | apply |
|---|---|---|---|---|
| replay the log | 60,000 events | 13.5 MB | 5.1 MB | **61.2 s** |
| full snapshot | 30,000 rows | 3.4 MB | 0.5 MB | 9 ms |
| scoped (2 of 8 teams) | 7,500 rows | 0.9 MB | 0.1 MB | 2 ms |
| scoped + windowed (2,000 newest) | 2,000 rows | 0.4 MB | **0.1 MB** | 3 ms |

Gzipped reduction versus replay: **full 10.2×, scoped 39.6×, windowed 95×**.
Apply time falls 61.2 s → 9 ms because a snapshot carries no per-event
signatures to verify.

The complexity is the real result:

| replay the log | O(all history) — grows forever |
| full snapshot | O(all state) |
| scoped snapshot | O(your data) |
| **scoped + windowed** | **O(your screen)** — independent of workspace size |

A 2,000-row window costs 0.1 MB whether the workspace holds 60,000 events or
1,000,000. That is the difference between a join that gets slower every month
and one that does not.

## The encoding matters as much as the scoping

The first implementation stored a `RowRecord` as-is, and a full snapshot came
out **twice the size of the log it replaced** — 90 MB against 45.6 MB at
200,000 events. Every cell carried its own stamp, and every stamp repeated
the author's 64-character hex peerId: ~540 bytes of provenance per ~100 bytes
of data.

`src/protocol/snapshot-codec.ts` fixes it with three observations:

1. **Peers repeat** — one dictionary, stamps reference an index.
2. **Columns repeat** — one dictionary per table, values positional.
3. **Most cells share the row's write stamp** — a row written by one event has
   every cell at that stamp, so store it once and list only the exceptions.

That alone is >3× before compression, and it is what turns "the snapshot is
bigger than the log" into "the snapshot is a tenth of it".

## Who vouches for a snapshot?

This is the honest cost of the design, and it has no single answer.

An event is self-authenticating: it carries its author's signature, so a
relay can forward it without being trusted. **A snapshot is derived state.**
Whoever folded it could have folded it wrong, or lied. Three deployments,
three answers:

| topology | who signs | what a receiver checks |
|---|---|---|
| authority present (RFC-0010) | the authority signs the snapshot | one signature; the authority is already trusted for `server-ops` |
| relay only | nobody | snapshot is **provisional**: accepted for display, audited in background |
| pure mesh | the peer that served it | same, plus the state-hash comparison below |

The audit is already specified: **state-hash anti-entropy** (RFC-0014). A
device that joined by snapshot exchanges per-`(group, table)` digests with
other peers. Agreement is evidence the snapshot was honest; disagreement
drills down to per-row hashes and repairs. A lying snapshot is therefore
detectable by anyone holding the events, and cheap to detect.

The snapshot additionally carries **signed feed heads** (RFC-0002): for each
author, the hash-chain head at the cursor the snapshot claims. Those *are*
self-authenticating. They do not prove the rows are the correct fold, but
they pin the exact input set the fold claims to be over — so a dishonest
server cannot pretend the snapshot covers events it does not.

## Where the log still matters

Nothing here removes the event log. It remains:

- the **source of truth** each device folds from at boot (RFC-0004)
- what **peers exchange live** — small deltas, one to ten events at a time
- what **backfill** serves when a user scrolls into history
- what **anti-entropy** repairs against
- what makes a snapshot *checkable* at all

What changes is that the log stops being the **join** mechanism. Compaction
(RFC-0015) then does its half: the log is bounded at the ack floor, and
everything below it is represented by state.

## Current state → work

| Piece | State |
|---|---|
| `mergeRecord` — stamp-respecting row merge | **built** (`src/core/kernel.ts`) |
| `Engine.snapshotFor({interest, window})` | **built** — partition, table, predicate and window scoping |
| `Engine.installScopedSnapshot()` | **built** — merges, adopts cursors, emits one fold batch |
| Tombstones included in a scoped snapshot | **built** |
| `bench/join.ts` — the four strategies | **built** |
| Compact snapshot codec (dictionaries + stamp dedup) | **built** (`src/protocol/snapshot-codec.ts`) |
| Snapshot over the relay protocol (paged, like catch-up) | proposed |
| `BACKFILL` request + windowed reply | proposed |
| Signed feed heads attached to a snapshot | proposed (the heads themselves exist, RFC-0002) |
| Authority-signed snapshots | proposed (RFC-0010) |
| State-hash audit after a provisional join | proposed (RFC-0014) |

**Tests to pin:** a scoped join followed by live events equals a full replay
for the scope; a backfill request never resurrects a tombstoned row; a
snapshot whose cursors exceed its rows is rejected rather than adopted; two
devices that joined with different scopes converge once their interests meet.

## Open questions

- Should a windowed snapshot advertise its window boundary, so the client
  knows where backfill must start rather than guessing?
- Does a provisional (unsigned) snapshot need to be marked in state, so a UI
  can distinguish "verified" from "shown pending audit"?
- Backfill by key range or by time range? Time is what users scroll by; keys
  are what the kernel indexes.
