# Gap audit before the fixing pass

> Taken 2026-09-11 on `t3code/8d5681ce` (tip `b85a13c`). Method: every epic's open
> checkboxes and "still open" clauses inside checked ones; the reflectdb A-list
> re-verified line by line against the current relay; the chaos harness's own record;
> `vp check` and the full suite run fresh. Tree state that day: **0 lint errors / 51
> warnings, all 37 workspace test tasks green** after `vp run -r build` (the one "test
> failure" was a missing `dist/`, not a defect). Zero TODO/FIXME markers in source —
> every gap below lives in the plan or in behavior, not in comments.

## P0 — decisions that block work (decide before writing code)

1. **D24 is the cork in the bottle.** Drafted, undecided; E08's `visibility:
   "authority"` tier was attempted and rejected 2026-08-28 pending it (E08.md:25).
   Downstream it blocks `mesh.visibility` (E09), the relay's `token()`/`visibleAt()`
   and the `Relay` transport class (E12), and use-cases.md:586's acknowledged hole
   (an authority-visibility row can't be obtained peer-to-peer). One decision
   unblocks four workstreams.
2. **The relay confidentiality posture is still unwritten** (E24.md:20). The
   machinery exists — `verifyJoin` hook, `announce`/`rooms` split (posture.ts) — but
   the default admits every join, the relay verifies no grant, and E24's own words
   still apply: "Any socket can currently join any room and pull the whole log.
   Decide the posture; silence is not one."
3. **E27 thin client starts with a decision, not code**: "is this a supported shape
   or a demo?" — and it is mechanically blocked on E24's versioned row patches
   (epoch + monotone id) either way.
4. **E12's relay-ack-as-`synced()`** is flagged "decide before building" (naming a
   relay in `engine.acknowledge` wants a device key the relay lacks).

## P1 — real holes in shipped code

Relay (the reflectdb A-list, re-verified — most is now FIXED: origin allowlist,
frame-size cap, per-socket token-bucket rate limit, bounded sender that closes on
overflow, opt-in event/blob retention and idle-room eviction, durability + fleet,
version negotiation). What remains:

5. **No connection cap of any kind** — no per-IP, per-room, or per-process socket
   count anywhere in `packages/relay` or the DO adapter; `room.clients` is unbounded.
   The only A1 item still fully open, and E24's task list doesn't even name it.
6. **The send backlog is bounded in frames, not bytes** (`maxBacklog = 1000`,
   room.ts:126): a thousand near-8 MiB blob frames is ~8 GB of retained buffers. The
   ceiling needs a byte semantic (reflectdb's `maxBufferedBytes`).
7. **Rate limiting meters ingress only.** Fan-out — the amplification vector
   reflectdb documents — is unmetered per room.
8. **Every retention/eviction knob defaults to off**, so an unconfigured relay
   still grows forever. Choose production defaults (or make the hosted presets set
   them) rather than shipping infinite-growth-by-default.
9. **BLE has never touched hardware.** The manual device checklist has every box
   unchecked, and two donor mechanisms are recorded as wrong (E22.md:20): silent
   data loss on multi-fragment ack, and `maxFrameBytes = 140` (~350 bytes on air)
   vs the 182-byte ATT payload — peripheral→central likely truncates on a real
   radio.

## P2 — durability proof and chaos blind spots

10. **Chaos doesn't run anywhere automatically.** It's a standalone workspace with
    its own `run` script, outside the default test task — nothing executes it on
    push. Wire a small-seed run into CI.
11. **Grant propagation under fault is untested** — the harness hands out grants at
    boot deliberately (chaos README: "a run that loses one loses everything after
    it"). It needs its own schedule switch.
12. **Blobs and retention-floor refusals are not exercised** by the chaos schedule.
13. **Crash-safety and format migration have no tests**: `kill -9` mid-fold /
    mid-append, torn writes, `_syncmesh_meta` version upgrades. This plus №10–12 is
    the "no acknowledged event is ever absent from a converged replica" invariant —
    the durability proof this repo's whole pitch rests on.
14. **E28 stale-link detection is missing from the state machine** (E28.md:96): a
    link that is up but silent is indistinguishable from a working one; only the
    budget sweep or outright failure reclaims a slot.

## P3 — loose ends inside "done" epics

15. E17: `_partition` injected by the pinned handle — still open (E17.md:20);
    Postgres state port validation against your table's actual columns at
    construction (E17.md:24).
16. E08 watch-out live even before D24: a withheld event stalls that author's whole
    stream — the gated tier needs its own sequence.
17. E06: field-level read restriction at the relay (`fields:` rules) unbuilt;
    ungranted-mode `deny` non-enforcement is documented but pinned by no test.
18. E13 watch-outs: interest is a request, not a permission ("the one way this
    feature could become a data leak"); an interest change leaves a permanent gap
    unless re-desire re-requests from an honoured cursor.
19. E14: the snapshot window is not yet a field of `Interest`.
20. E16: mixed-version-fleet correction mismatch (RFC-0013 G18) has no mitigation.
21. E19: the 60 Hz presence burst test and BLE-shaped drop test are unwritten.
22. E15: blob compaction sweep + per-partition quotas — deliberately unsized until a
    real workload; rounds-web may now be that workload.
23. E24/E09 contradict each other on `mesh.transports.add/remove` (E24 wants it,
    E09 deliberately marks it absent). Reconcile.

## P4 — observability and DX debt

24. Telemetry union has **no consumer**: no inspector, mesh/relay don't re-emit, no
    storage taps, policy verdict is a bare boolean with no "why" (codebase-map:223).
25. rounds-web's only test is a manual Playwright smoke script (`bun run smoke`
    against a live dev server) — no runner picks it up; the three faults it guards
    are protected by nothing in CI.
26. `@syncmesh/sqlite-bun` is installed but never imported by
    `verify-node-consumer`; sqlite-node's durable path only covered indirectly.
27. 51 lint warnings (mostly implicit string coercion — the convert-once rule);
    the Effect anti-slop oxlint variant exists but isn't enabled; one benchmark
    total (`bench/storage`).

## Doc rot (cheap, but misleads the next reader)

28. **E24.md:18 is now false** — it still says "nothing in the relay caps or evicts
    anything"; retention.ts / blob-cap.ts / rooms.ts exist. Update the epic.
29. codebase-map.md is pinned to `29dac35` and calls `packages/drizzle` untracked
    WIP with a `test.todo`; it is committed, built, and its suite passes.

## From the fork/external-writer thread (design work, not yet planned)

30. Strict capture mode: unarmed writes to synced tables should **raise**, not
    silently diverge (one branch in the existing plpgsql/trigger guard, opt-in).
31. The external-writer story (table classes a/b/c, staged-changes sweeper, WAL
    capture as last resort) and the `syncmesh` pg schema for bookkeeping — wants an
    RFC; both slot into E24/E25.

## Reconciliation with the book (added 2026-09-11)

`research/syncmesh-book.md` supersedes several items above and absorbs the rest of
this conversation's research:

- **№1 (D24) is decided by the book's pattern**: writes gated with `allow:
  authority()`, reads replicate; secrets are private tables behind the module
  boundary (field-level read rules are deliberately absent, ch. 15). The E08
  authority-visibility *tier* as drafted does not survive.
- **№3 (E27) and the row-level interest chain are retired**: `http()` is the
  degenerate mode (ch. 16), interest shrinks to `{ partitions }` (ch. 26), partial
  partitions are a NEVER — so №13's versioned-row-patch prerequisite and E13/E24's
  row-path work fall away.
- **№31's WAL-capture last resort is dead**: logical-replication slots are a NEVER
  (ch. 21). External writers are CDC (kept, ch. 26) with watermarks, plus
  `systemProcedure` as the explicit operator escape; "an uncaptured SQL write is not
  a syncmesh write" (ch. 19) is №30's strict posture, book-blessed.
- **Still standing regardless of the book**: the relay P1 holes (№5–8) apply to the
  machinery that survives as `createServer`-with-no-handlers; BLE hardware truth
  (№9); chaos-in-CI and the durability proof (№10–13); doc rot (№28–29).
- **Implementation now proceeds by the book's build order** (ch. 27, Phases 0–6),
  not by this audit's suggested order; this audit's surviving items fold into those
  phases (relay holes → Phase 4–5 territory, durability proof → Phase 1's gate).

## Suggested order

Decisions first (№1–4 — they're blocking and cost no code), then the relay's P1
holes (№5–8 are small and compounding), then the durability proof (№10–13, the
credibility work), then BLE hardware (№9, needs devices in hand), then the P3 loose
ends epic by epic. P4 and doc rot interleave as warm-up tasks.


## Addendum 2026-09-26 — code-level audit and the first fixes

An independent read of the source (not the plan) found three gaps the list above did not name:

1. **No clock-skew bound** — `createHlcClock({ now })` with no `maxDrift`, and no rung judging a
   stamp; a fast clock won every `lww` cell and dragged every receiver's clock. **Fixed** (D34).
2. **The relay trusted a claimed identity** — a bare `peerId` on `join`, `verifyJoin` defaulting
   to admit, the superseding join closing the previous socket. **Fixed** (D33, protocol v2). The
   relay link still skips the link handshake; that is D33's option C, now on E24's list.
3. **Scale** — whole replica in memory, table map copied per write, tombstones never collected,
   Wi-Fi Aware stubbed, no Android radio module, device seed in plaintext SQLite. Open.

Also recorded: the conformance vectors cover event cores, receipts, grants and accounts only —
no session frames, framing, handshake or relay control frames. Widening them is the prerequisite
for a second (Rust) implementation of kernel + wire + storage + bridge, which is the direction
the owner chose on 2026-09-26; see `docs/research/sync-engines.md` §5 in paper-canvas.
