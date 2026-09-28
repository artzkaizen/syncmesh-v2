# Fork evaluation — LiveStore or Zero as the base for syncmesh

> Written 2026-09-11. Question: should this repo fork `livestorejs/livestore` or
> `rocicorp/mono` (Zero) and build syncmesh around it, instead of continuing the
> hand-built engine?
> State that day — LiveStore: **0.4.0, beta**, Apache-2.0, breaking changes still
> expected in APIs, local storage format, and sync backend. Zero: **1.9.x, stable**
> since 1.0 (June 2026), Apache-2.0, client + `zero-cache` + ZQL/IVM in one monorepo.
> syncmesh: 16 packages, ~150 src / ~120 test files, all green; wire bytes frozen by
> conformance vectors; epics E00–E22 essentially done, remaining work is Wi-Fi Aware
> (E23), hardening (E24), hosting (E25), thin client (E27).

## The goal, restated as pass/fail criteria

The eval is only meaningful against what this repo says it exists for (README:3-5,
[[competitor-reflectdb|research/competitor-reflectdb.md]]):

1. **Nobody is trusted.** Every receiver re-verifies sig → grant → policy. Events are
   Ed25519-signed; peerId *is* the public key.
2. **Truth is the local log.** The local commit is the truth; writes are local-first
   and *not optimistic* — there is no pending state to roll back (use-cases.md:469).
3. **Mesh topology, any transport.** A server is a peer with better uptime. Reach is
   anywhere *radio* goes — relay, BLE (E22, done), Wi-Fi Aware — including no internet.
4. **Partition is the unit of replication** (D07), interest-based partial sync (E13).
   Never the query.
5. **Receivers never run app code** (D10). Events carry captured diffs applied by a
   fixed fold routine; conflict = per-cell lattice join (D04).

## Zero against the criteria

| Criterion | Zero | Verdict |
|---|---|---|
| Nobody trusted | `zero-cache` is fully trusted by construction; it is a read replica of *your Postgres* and the arbiter of every query result | ✗ |
| Truth is the local log | "A Zero client never sees the event log" (RFC-0018). The client holds a cache of server rows; Postgres is the truth | ✗ |
| Mesh / any transport | Star. Client ⇄ zero-cache ⇄ Postgres over websocket. No peer link, no radio, no offline authority | ✗ |
| Partition as unit of sync | The *query* is the unit of sync — ZQL subscriptions maintained by server-side IVM. D20 rejects this by name | ✗ |
| No app code on receive | Custom mutators are named app functions replayed on the server, client state rebased on the result (the D26 fire-and-forget contrast) | ✗ |

Zero is the best-engineered version of the thing syncmesh refuses to be. It went
stable precisely *because* it narrowed to server-authoritative Postgres sync. A fork
would keep the ZQL/IVM engine — which D20 and RFC-0018 already rejected ("SQL is the
data API"; live queries are exact-invalidation re-runs, not IVM) — and would have to
delete the client cache model, the rebase machinery, zero-cache itself, and the
Postgres-as-truth premise. That is not a fork; that is an exorcism.

## LiveStore against the criteria

LiveStore is the closer phenotype — client-side SQLite, event sourcing, an
eventlog/materialized-state split this repo already mined
([[prior-art-livestore|research/prior-art-livestore/]]). Its store-per-eventlog shape
even rhymes with D07's one-file-per-partition. The resemblance ends at the trust and
ordering layer:

| Criterion | LiveStore | Verdict |
|---|---|---|
| Nobody trusted | One upstream sync backend per store owns the **global total order**; clients pull-then-push, git-style. Events are unsigned; the auth/authorization docs section is literally "TODO" | ✗ |
| Truth is the local log | Half. The local eventlog is real, but local pending events **rebase** against upstream — upstream ordering wins, so the backend's log is the truth of record | ~ |
| Mesh / any transport | Sync *providers* (Cloudflare Workers, Electric, S2, custom), all central backends. No peer-to-peer link, no BLE | ✗ |
| Partition as unit of sync | A store syncs its whole eventlog; partial sync of one log isn't supported. Multi-store is the workaround, but interest (E13) and the reserved `user`/`local`/`global` kinds don't exist | ~ |
| No app code on receive | Materializers are app code replayed on every client to derive state — exactly what D10 forbids receivers to do | ✗ |
| Stability | 0.4 beta; breaking changes expected in the **sync format and storage format** — against our frozen wire vectors | ✗ |

Forking LiveStore means replacing total-order-with-rebase by the HLC lattice, adding
per-event signatures and receiver-side policy, replacing materializers with captured
diffs and the fixed fold, adding the partition/interest model, and writing the peer
transport tier from scratch. What survives is the reactive-SQLite plumbing — which
this repo already has, tested and green.

## The real criterion: proven work, no lost events

Sunk cost is not an argument — the code already written here earns nothing by
existing. The question that matters is: which option is least likely to lose an
event? Trace where events physically live and where each system is allowed to drop
one:

| | Where events live | How one gets lost |
|---|---|---|
| Zero | Nowhere — Postgres holds rows, zero-cache is a disposable replica, the client is a cache | A rejected mutation is reverted **by design**; under server authority your write only exists once the server accepts it |
| LiveStore | Local SQLite eventlog + one central backend's log | Beta docs explicitly reserve breaking changes to the **local storage format and sync format** — the two formats events are stored in; auth is TODO, so any writer can also pollute the log |
| syncmesh | Append-only log on **every** device (the log *is* the outbox), rows additionally folded into Postgres at the authority peer (E17) | An unproven code path in capture/fold/transport — bugs, not architecture |

Two conclusions fall out. First, **proven-ness does not survive the fork surgery.**
Zero's production miles attach to the trust-Postgres arrangement itself; LiveStore's
attach to central-total-order rebase and replayed materializers. The surgery syncmesh
requires replaces exactly the ordering-and-apply core — the code that decides whether
an event survives. A fork ships a proven name over novel code, which is strictly
worse than novel code that admits it.

Second, syncmesh's durability *architecture* already dominates both: replication
factor N (every peer a full copy) instead of LiveStore's one backend log, plus the
most-proven store in the industry (Postgres) holding the folded rows at the authority
peer — Zero's comfort, without Zero's trust requirement. What syncmesh lacks is not
architecture but **proof**: crash-safety under `kill -9` mid-fold, torn-write
recovery, storage-format migration tests, and a chaos invariant "no acknowledged
event is ever absent from a converged replica". That is E24, and it is cheaper than a
fork — and unlike a fork, it produces evidence about the code that will actually run.

## When the answer flips

- If the goal were re-scoped to *server-authoritative web apps on Postgres*: don't
  fork Zero, **use** it as a dependency. It is stable and does that job well.
- If re-scoped to *single-authority local-first without mesh or radio*: use LiveStore
  as a dependency and accept beta churn.
- Neither re-scope is on the table; both are the reflectdb conclusion again with
  better competitors.

## Borrow, don't fork

Keep reading them the way this repo already does:

- LiveStore: eventlog **compaction** design (their roadmap, our eventual retention
  story), client-session/leader head tracking, devtools UX.
- Zero: the view-syncer and IVM internals stay relevant reading for E27 thin client
  and RFC-0020 server-authoritative live queries — the one corner of syncmesh that
  *is* server-shaped.
- Both: deployment recipes (zero-cache single-node topology; LiveStore's Cloudflare
  DO provider) for E25 hosting.

## Verdict

**Fork neither.** Zero fails all five goal criteria by construction; LiveStore fails
the three that differentiate syncmesh — and on the durability criterion specifically,
LiveStore is the *worst* option (beta format churn where events live) and Zero's
safety is inseparable from the server trust this engine exists to refuse. Proven-ness
is not transferable through the required surgery. Continue the hand-built engine, and
answer the "unproven" objection head-on by pulling the E24 durability proof forward:
crash-safety, format-migration tests, and the no-lost-acked-event chaos invariant.
