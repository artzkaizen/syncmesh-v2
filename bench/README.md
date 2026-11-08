# bench

Benchmarks that back the numbers quoted in the RFCs and decisions. `bun run bench` at the root runs
`storage`; add one script per benchmark here.

## scale (`src/scale/`) — the one that fails the build

Every other benchmark here **reports**. This one **refuses**: `bun run --cwd bench scale` exits
non-zero when a hot path stops holding the shape it declared.

It exists because the test suite cannot find these bugs. The suite runs on 120 seeded issues,
where an O(n) fold and an O(n²) fold cost the same; the bugs live at half a million rows. Every
scale problem this repo has had passed types, passed lint, passed review and passed all 60 tests.

**The assertion is on the curve, not the clock.** Each path is measured at three sizes, each 4×
the last, and the check is the _ratio_ between them — `constant` claims a per-call cost that does
not move as the data grows, `linear` claims it moves no faster than the data does. A ratio on one
machine in one run cancels the machine out, which is what an absolute budget in microseconds can
never do: it varies threefold across hardware, so it is either too loose to catch anything or too
tight for a busy runner, and either way it gets deleted. A `budget` is accepted _as well_, for the
other question — `counts` is allowed to be linear, but linear with no index behind it is linear
and far too slow. **The class catches the wrong algorithm; the budget catches the missing index.**

Each path carries a `because`: the sentence quoted back when it fails, so a regression reads as a
diagnosis rather than as two numbers that disagree.

Adding one is a `path({ name, growth, because, sizes, prepare, run, budget? })` in
`src/scale/index.ts`. Put everything but the single call under test in `prepare`.

### Every path holds, and `bun run ci` runs the gate

Apple M-series, bun 1.4.4, fastest of five rounds — 2026-11-07. Before is `main` at `638eed6`; the
growth column is the two consecutive 4× ratios.

| path                                      | claim                     | before                          | after                         |
| ----------------------------------------- | ------------------------- | ------------------------------- | ----------------------------- |
| `kernel · applyChange`                    | constant in live rows     | 4.96 → 58.2 µs (**2.6×, 4.5×**) | 0.45 → 0.53 µs (1.2×, 1.0×)   |
| `kernel · mergeRecord` (snapshot, repair) | constant in live rows     | 3.17 → 34.0 µs (**3.5×, 3.1×**) | 0.37 → 0.37 µs (1.2×, 0.9×)   |
| `engine · memory store lastSeq`           | constant in log length    | 4.58 → 69.7 µs (**3.8×, 4.0×**) | 0.01 → 0.01 µs (1.0×, 1.1×)   |
| `wire · encodeCbor`                       | linear in bytes, ≤ 200 µs | **3,767 µs** at 256 KiB         | 37 µs at 256 KiB (3.3×, 4.2×) |
| `wire · sealPayload`                      | linear in bytes           | 3.7×, 3.6× — holds              | 3.4×, 3.9× — holds            |
| `kernel · mergeCells`                     | constant in columns       | 0.39 → 1.19 µs (**1.4×, 2.1×**) | 0.66 → 0.42 µs (0.7×, 1.0×)   |

What fixed them:

- **The fold** writes through `withEntry` (`packages/kernel/src/persistent-map.ts`), a persistent
  `ReadonlyMap` over one native `Map` per lineage: the newest version reads the `Map` directly,
  older versions are one-entry diffs that reroot onto it when read. `applyChange` and
  `mergeRecord` still return a new state and leave the input untouched, iteration order is still
  a `Map`'s, and a write costs one entry at each level — tables, rows, cells. A plain `Map` (a
  state loaded at boot) is copied once, on its first write.
- **The CBOR writer** fills one `Uint8Array` that doubles when full, and copies byte strings and
  text with `set` instead of spreading them. The bytes are the same; the conformance vectors say so.
- **The memory event store** keeps the highest sequence per author as it appends, so `lastSeq` —
  asked on every write — stops walking the log.

`engine · fold`, `installSnapshot` and repair all fold through `applyChange`/`mergeRecord`, so the
first two paths cover them. `tableDigests` and `stateSnapshot` scan the whole state, but once per
call rather than per change, which is their honest shape. The `localStorage` event store rewrites
its whole key per append — documented on the store, and bounded by compaction rather than here.

## scale-tenant (`src/scale-tenant/`): the ten-million-row tenant

`bun run --cwd bench scale-tenant -- --rows 10000000 --backend sqlite|pglite|postgres [--url …] [--budget-minutes 100]`

A Company OS-shaped tenant: `issues`, `messages`, `contacts`, `deals` and `activity`, 256 team
partitions and 16 authors. Each event is one team's burst of 10 changes, so ten million rows is a
million events. The run folds the tenant into an authority through `receiveBatch` with durable
stores and `atomic`. It reads the materialised tables back through plain SQL (point lookup, team
inbox page, board counts, pipeline sum; 30 samples, p50/p99). It reopens the authority from
persisted state. A device on 4 teams then joins over a filtered catch-up and adopts the scoped
coverage, as the relay session does. The tenant drifts by 1% while the device is offline, the
device catches up, and the run checks that device and authority digest the same over its teams.
The device is always SQLite; the authority is the backend under test. Signatures are not part of
these events: `join` measures verification.

The budget stops only the fold. A fold still running at the deadline is `abandoned` with the
rows it reached, and every later phase runs on what was loaded. The JSON in `.bench/` is
rewritten after every phase, with the phase in progress marked `running`, so a run the OOM
killer stops still says how far it got. It exits non-zero unless every phase is `ok` and every
invariant held. `bench/src/__tests__/scale-tenant.test.ts` runs it at 2,000 rows on SQLite and
PGlite on every push. The ladder up to 10M runs nightly (`.github/workflows/nightly.yml`).

### First runs: Apple M4 Pro, bun 1.4.4, 2026-11-07

**10 million rows does not hold today.** On SQLite the fold reached 795,000 rows (79,500 events)
in its 30-minute budget and was abandoned there. It started near 2,300 rows/s and was down to
about 170 rows/s by 250,000 rows, with RSS swinging between 1.5 and 3.6 GB. That run shared the
machine with test runs for its first stretch, so read the curve, not the absolute rate. The
uncontended 200k run below shows the same shape: 13,657 → 1,514 rows/s across its ten tenths.
That is the per-change cost growing with the live table: the `kernel · applyChange` row of the
scale table above, now visible end to end. A sibling fix owns it.

|                             | SQLite, 200,000 rows                   | PGlite on disk, 50,000 rows  |
| --------------------------- | -------------------------------------- | ---------------------------- |
| fold                        | 41.7 s; 13,657 → 1,514 rows/s by tenth | 32.2 s; 1,846 → 1,057 rows/s |
| peak RSS (fold / whole run) | 965 MB / 3.1 GB                        | 2.5 GB / 3.0 GB              |
| storage                     | 319 MB, 1,593 B/row                    | 68 MB, 1,370 B/row           |
| point lookup p50 / p99      | 0.24 / 2.2 ms                          | 0.11 / 0.74 ms               |
| team inbox page p50 / p99   | 7.5 / 121 ms                           | 1.7 / 4.9 ms                 |
| board counts p50 / p99      | 3.8 / 96 ms                            | 0.7 / 8.3 ms                 |
| boot from persisted state   | 3.4 s, all 200,000 rows in memory      | 5.9 s                        |
| join, 4 of 256 teams        | 1.2 s, 312 events                      | 1.5 s, 79 events             |
| catch-up after 1% drift     | 85 ms, 4 events                        | 23 ms, 2 events              |
| convergence                 | ✓                                      | ✓                            |

What the numbers say, besides the fold:

- **Memory is the whole replica.** Boot holds every row in the engine. At about 15 KB of peak
  RSS per row on SQLite, ten million rows would not fit in a CI runner's 16 GB even with the fold
  fixed.
- **The team-scoped SQL scans.** `tableDdl` constrains only the key (D20), so
  `WHERE _partition = ?` reads the whole table. The inbox p99 is 121 ms at 200k rows and grows
  linearly with the table. An index on `_partition` (and the app's own sort column) is the
  missing piece.
- **About 1.6 KB per row on SQLite.** The log keeps each event's core, the sidecar keeps every
  record and stamp, and the app's table keeps the row, so a row is stored about three times.

## storage (`src/storage.ts`)

Apple M4 Pro, bun 1.4.0, `bun:sqlite` on disk with WAL and `synchronous = NORMAL` — 2026-08-25.

| benchmark                                                         | avg            |
| ----------------------------------------------------------------- | -------------- |
| append 1,000 events — `append()`, one call per event              | 35.0 ms        |
| append 1,000 events — `appendBatch()`, one transaction            | 12.9 ms (2.7×) |
| boot, 20,000 events behind 5,000 live rows — refold the whole log | 469 ms         |
| boot, 20,000 events behind 5,000 live rows — open persisted state | 79 ms (5.9×)   |

RFC-0004's 450–650× for batching was measured with the default journal mode, where every implicit
transaction pays an fsync; WAL + `NORMAL` already removes that, and what is left is statement
overhead. The boot gap is the one that matters: refold is O(events) for the life of the app, open
is O(live rows).
