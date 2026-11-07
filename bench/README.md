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
first two paths cover them. `tableDigests` and `snapshotOf` scan the whole state, but once per
call rather than per change, which is their honest shape. The `localStorage` event store rewrites
its whole key per append — documented on the store, and bounded by compaction rather than here.

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
