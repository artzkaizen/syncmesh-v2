# bench

Benchmarks that back the numbers quoted in the RFCs and decisions. `bun run bench` at the root runs
`storage`; add one script per benchmark here.

## scale (`src/scale/`) — the one that fails

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

### As of writing, three of four paths fail — all of them real

| path                   | claim                     | measured                            |                                                                                                                      |
| ---------------------- | ------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `kernel · applyChange` | constant in live rows     | 2.4 → 21.2 µs (**2.6×, 3.4×**)      | `withRecord` copies the whole table and the whole state per change, so replaying a log is quadratic in its own state |
| `wire · encodeCbor`    | linear in bytes, ≤ 200 µs | linear, but **3,125 µs** at 256 KiB | the writer pushes into a `number[]` one byte at a time and spreads on top; a preallocated `Uint8Array` is ~30 µs     |
| `kernel · mergeCells`  | constant in columns       | 0.36 → 1.03 µs (**1.4×, 2.1×**)     | the cell map is rebuilt per change, so wide tables pay the same tax as large ones                                    |
| `wire · sealPayload`   | linear in bytes           | 3.5×, 3.9× — **holds**              | the control: an AEAD is one pass, and a failure here would mean the harness is measuring noise                       |

**Not wired into `bun run ci` yet**, on purpose: it would fail the build today. Add
`&& bun run --cwd bench scale` to the root `ci` script once the fold is fixed, and it stays fixed.

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
