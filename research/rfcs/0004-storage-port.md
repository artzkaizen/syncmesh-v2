---
rfc: 0004
title: Storage Port
package: syncmesh (src/storage)
layer: 2
status: implemented
standalone: false
deps: ["0002"]
---

# RFC-0004 — Storage Port (`EventStore`)

## Purpose

One seam between the engine and durability, so the same engine runs on Bun,
in the browser, and in React Native without a single `if (platform)` in core.

## The port

```
EventStore {
  append(event)             idempotent by event id
  scan(cursors?)            events after the given per-author cursors
  // optional snapshot tier:
  saveSnapshot(state, coverage)
  loadSnapshot()            → boot = snapshot + tail, never a full refold
}
```

The engine never names a backend. A backend never interprets events beyond
the id/cursor fields it indexes — payload bytes are opaque (signatures must
survive storage byte-identical, RFC-0002).

## Backends today

| Backend | Platform | Notes |
|---|---|---|
| `bun-sqlite-store.ts` | Bun / server | reference implementation |
| `opfs-sqlite-store.ts` | Browser | sqlite-wasm; needs a crossOriginIsolated worker |
| `drizzle-event-store.ts` | anywhere drizzle runs | Drizzle 1.0 RC (`drizzle-orm@1.0.0-rc.4`, pinned) over the bun-sqlite driver |
| `local-storage-store.ts` | Browser fallback | corrupt-persistence recovery is tested (recovers empty, warns) |

**Scoped stores:** `createClient({ storeFor: (scope) => EventStore })` runs
one engine per storage scope — `"org:acme"` per top-level partition instance,
`"user"` for account data. Logs never mix; leaving an org = dropping ONE
store. (RFC-0008 partitions define the scopes; this port just opens them.)

## Forbidden leaks

- No backend may import from `src/core` beyond the `EventStore` type.
- The engine may not reference sqlite, OPFS, drizzle, AsyncStorage, or any
  storage name outside `src/storage`.

## Batch commits are part of the port `[implemented]`

`append()` once per event is the wrong granularity for a persistent store. On
bun:sqlite each call is its own implicit transaction — one fsync per event —
measured at **~1,000 events/s**. The identical events committed in a single
transaction: **~660,000/s**. That is a 450× difference hiding behind an
innocuous-looking method.

So the port carries an optional bulk door, and the engine's batched applies
use it (`receiveBatch`, `receiveWireBatch`):

```ts
appendBatch?(entries: ReadonlyArray<{ event: SyncEvent; sigHex?: string }>): void;
```

Stores that cannot batch simply omit it and get today's behavior. Measured
end to end (`bench/storage.ts`, sqlite on disk): a device applying a
100,000-event catch-up went from **~70 s to 334 ms**.

Two settings ride along in `BunSqliteEventStore.open`: `journal_mode = WAL`
(readers never block the writer) and `synchronous = NORMAL` (a power cut can
cost the last commits but never corrupts the file). Losing unshipped tail
events is already survivable — the log re-heals from peers on catch-up — so
this is the correct trade for a local-first store, and it is the same stance
the localStorage store takes on corruption.

## Persisted materialized state `[implemented]`

The event log answers *what happened*; it is the wrong thing to re-fold on
every cold start. A device that already computed its state should read it
back. `StateStore` (`src/storage/state-store.ts`,
`BunSqliteStateStore`) persists the folded rows themselves:

- **row-granular and incremental** — only the keys a batch touched are
  rewritten, so steady-state cost tracks the *write*, not the workspace
  (pinned by a test: one update to a 500-row table writes one row)
- **rows and cursors commit in one transaction** — otherwise a crash leaves
  state claiming events it never folded
- **the cache is never partially trusted**: `loadAll()` returns `null` on any
  damaged row and boot replays the log instead. A partial set would be
  invisible, because the cursors claim those rows are covered.
- validation is a hand-written check, not a zod parse — this runs once per
  row on the boot path and zod measured ~2× the cost of `JSON.parse` itself

It also needed `allSince(floor)` on the event-store port. Without it the
engine called `all()` and SQLite decoded **the entire log in JS** just to skip
it — persisted state saved the folding but not the reading, and measured no
better than a replay. With the floor pushed into SQL:

| history behind 5,000 live rows | replay | open persisted state | |
|---|---|---|---|
| 10,000 events | 16 ms | 7 ms | 2.2× |
| 30,000 events | 41 ms | 9 ms | 4.5× |
| 105,000 events | 163 ms | 22 ms | 7.5× |
| 305,000 events | 502 ms | 52 ms | **9.7×** |

That is the real point: **boot stops growing with history.** Replay is
O(events) forever; opening state is O(live rows), which is bounded by the
data the user actually has. On a young workspace the two are close (the
Linear-like bench sits at 1.5×); the gap widens for the whole life of the
app.

Remaining: `allSince` still scans the events table in SQLite (52 ms of the
above at 305k rows). Recording a rowid watermark alongside the cursors would
make it a range scan.

## Snapshots on real storage

`bench/scale.ts` uses the in-memory store on purpose (it isolates engine CPU),
which flatters the snapshot tier's competition. On disk, at a 100k-event log:

| boot path | time |
|---|---|
| full refold from sqlite | 172 ms |
| snapshot + tail from sqlite | 355 ms |
| full refold, in memory (what scale.ts reports) | 35 ms |

The hot tier is **still** a pessimization — a 10 MB JSON snapshot blob costs
more to parse than 100k rows cost to read and fold. It only becomes a win
when the snapshot is a binary format (the Rust port measured 4× from postcard,
`rust/README.md`) or when the log is far larger than the state it folds to.
Until then, the tier's real justification is the **join** path (a peer that
lacks the log entirely), not local boot.

## Remaining work

- **`ExpoSqliteEventStore`** (N2) — same contract over expo-sqlite; this is
  the only new code the React Native app needs from this layer.
- Durable relay-side store shares this port (RFC-0010, N4).
