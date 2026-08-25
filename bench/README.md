# bench

Benchmarks that back the numbers quoted in the RFCs and decisions. `bun run bench` at the root runs
`storage`; add one script per benchmark here.

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
