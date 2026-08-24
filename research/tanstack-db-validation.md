# Validation — should TanStack DB be the SyncMesh client layer?

> Asked again 2026-08-24. Previously decided 2026-06-28 (see `client-interface-proposal.md`,
> which is still unmarked as superseded). This is a re-validation against current facts,
> not a restatement of the old decision.

## Answer

**No — not as the client layer.** Three bounded pieces of it are worth taking, and the
thing that would actually save us client work is something else entirely (§6).

The reason is one sentence: **TanStack DB's write path requires a `mutationFn`, because
its model is an optimistic overlay held until something else persists. SyncMesh has no
overlay — the local commit *is* the truth.** Everything else is negotiable; that isn't.

---

## 1 · The facts, checked

| | Value |
|---|---|
| Our checkout `internal/exisiting/tanstack` | `928afa4a`, **2026-06-26**, `@tanstack/db` 0.6.12 |
| Current on npm | `@tanstack/db` **0.8.3** · `@tanstack/offline-transactions` **1.0.49** |
| Our client layer today | `src/react/` 696 LOC (3 files) + `src/client/client.ts` |
| Our own IVM | `src/ivm/` — used by the relay CVR + interest matching, **not** by the React layer |

Two things worth noting before anything else:

- **Our checkout predates the June decision by two days.** So the June call was made with
  essentially this information. It is not the case that TanStack has since grown
  persistence and offline support and we missed it — those packages were already there.
- **`offline-transactions` has since gone 1.0** (0.x → 1.0.49). That is the only
  materially new fact, and §4 explains why it solves a problem we don't have.

What the monorepo now contains that is relevant: `db` (core), `db-ivm`,
`db-collections`, `offline-transactions`, `db-sqlite-persistence-core` plus platform
persistence for browser / expo / react-native / electron / tauri / capacitor / node /
cloudflare-durable-objects, framework adapters for react / solid / svelte / vue / angular,
and collection adapters for electric / powersync / rxdb / trailbase / query.

---

## 2 · The seam is genuinely good

`packages/db/src/types.ts:327`:

```ts
export interface SyncConfig<T, TKey> {
  sync: (params: {
    collection: Collection<T, TKey, …>
    begin: (options?: { immediate?: boolean }) => void
    write: (message: ChangeMessageOrDeleteKeyMessage<T, TKey>) => void
    commit: () => void
    markReady: () => void
    truncate: () => void
    metadata?: SyncMetadataApi<TKey>
  }) => void | CleanupFn | SyncConfigRes
  rowUpdateMode?: `partial` | `full`
}
```

This maps onto us almost exactly. `engine.onFoldBatch(b => …)` → `begin()` / `write()`
per change / `commit()`; `markReady()` after the initial local fold (never waiting on
peers); `metadata.row.set(key, hlcStamp)` is a real home for our per-field stamps;
`rowUpdateMode: "partial"` matches our field-level change shape.

So **reads** would work. If the question were only "can our engine feed a TanStack
collection", the answer is yes, cleanly, in about 150 lines. The problem is writes.

---

## 3 · Why writes don't fit

### 3.1 `mutationFn` is mandatory
`packages/db/src/transactions.ts:226` throws `MissingMutationFunctionError` —
*"mutationFn is required when creating a transaction"* (`errors.ts:293`). Even
`localOnlyCollectionOptions` routes through one: its own utils doc says *"This should be
called in your transaction's mutationFn to persist local-only data."*

That requirement encodes a model: a write is a **guess** that is reconciled when the
`mutationFn` resolves and the real data syncs back. api-shape v13 §3 already named this
and rejected it:

> In TanStack DB, "optimistic" means an overlay held until your `mutationFn` persists to
> a server and the data syncs back — with the classic gotcha that the overlay drops when
> the handler returns, so handlers must await their own data back or the UI flickers.
> **Syncmesh has no overlay and no gotcha: the local commit IS the truth.**

Adopting TanStack DB means either writing a no-op `mutationFn` (carrying an overlay
machine that never does anything, and paying its reconciliation edge cases anyway), or
using its overlay for real (giving up the property that makes offline-first trivial for us).

### 3.2 The typed denial has nowhere to go
Our write returns a value:

```ts
tasks.insert(row)   // → Result<SyncEvent, NoActivePartition | WriteDenied | UnknownCollection | RowError>
```

`WriteDenied` comes from the same policy AST that every receiving peer will run, so the
call site learns *now* what the mesh will decide later. A TanStack collection mutation
returns void and signals failure by throwing from the transaction. There is no slot for
a typed denial, so we'd smuggle it — and we'd re-introduce exactly the two-error-model
problem `implementation-notes.md` §1 exists to remove.

### 3.3 Ambient partitions become manual
`client.collections.tasks` is scoped by the ambient partition; `client.setWorkspace(id)`
swaps it and a cross-workspace write is *inexpressible*. A TanStack collection is a flat
handle with its own lifecycle, so we'd need one collection per (table × partition
instance), created and disposed on navigation — and the guarantee degrades from
"impossible" to "we remembered to dispose it".

### 3.4 Errors are throws
`MissingMutationFunctionError extends TransactionError extends Error`. Our discipline
(D5) is that runtime failures are values and only definition-time mistakes throw. Not a
dealbreaker at the boundary, but it is a second model living in the hot path.

---

## 4 · `offline-transactions` solves a different problem

Its README: *"Outbox Pattern: persist mutations before dispatch for zero data loss ·
Automatic Retry · Multi-tab Coordination (leader election) · FIFO Sequential Processing ·
IndexedDB with localStorage fallback"*, with React Native support via
`@react-native-community/netinfo`.

Every one of those is machinery for **getting a mutation to a server that might be
unreachable**. Our write is durable the instant it commits (it is an event in the
`EventStore`), it ships by anti-entropy rather than dispatch, and "retry" is just the
next cursor exchange with any peer — not a server. We would inherit:

- an outbox in front of a log that is already an outbox,
- leader election across tabs, where our answer is one engine per storage scope,
- retry/backoff for a dispatch step we don't have,

and it would still do **none** of the work that is actually hard on our write path:
Ed25519 signing, grant admission, policy evaluation, partition stamping, HLC stamping,
mesh gossip. That's the part nobody else's client layer can give us.

---

## 5 · The other three mismatches, briefly

- **Persistence tier.** `db-sqlite-persistence-*` persists *collection state*. Our
  `EventStore` persists the *event log* plus a snapshot tier, because the log is what
  converges. Different tier; theirs cannot be our store, and ours already exists for
  bun-sqlite, OPFS, Drizzle and localStorage.
- **Hermes.** `db-ivm` on Hermes is still unmeasured. But note what we already have:
  `src/react/live-query.ts` is *already* incremental — sorted result + key index, enter /
  leave / move / update-in-place per changed key, O(changed · log n), property-tested
  against a full-re-run oracle. What it lacks is db-ivm's operator graph, i.e. **joins**.
  So the honest framing is not "re-run vs. IVM" — it is "single-table IVM vs. multi-way
  IVM", and the only question db-ivm answers for us is joins. Note also that TanStack's
  builder has the *same* `fn.toString()` problem we do, so the mandatory deps array is
  not a cost we'd escape.
- **Wire stability.** SyncMesh's deliverable includes byte-frozen conformance vectors
  that Swift and Rust ports must reproduce. Putting a fast-moving dependency (0.6 → 0.8
  in two months) on the read path of that system buys convenience at the cost of the
  property we sell.

---

## 6 · The real answer to "don't re-implement the client things"

The client layer is **already built and tested** — 696 LOC of React over a 400-LOC
client, with an incrementally-maintained `useLiveQuery`, `useLiveInfiniteQuery` (keyset only), `useLiveSuspenseQuery`,
`useLiveQueryEffect`, `usePacedMutations` with debounce/throttle strategies, `useEventLog`,
and a ref-counted `QueryRegistry` with structural-equality cutoff. That cost is sunk.
Adopting TanStack DB now is not a saving — it is a rewrite of working code.

The place where we *are* re-implementing something avoidable is different:
**`createThinClient`** (`implementation-notes.md` §10). The relay already speaks
`desire`/`undesire`/`rows` and `ClientView` is tested; there is no client counterpart, so
the row path is reachable only by hand-writing frames. That's ~300 LOC that deletes the
need for a local engine in the "just show me server rows" case — which is the actual
scenario TanStack DB + Electric would have covered.

---

## 7 · What to take from TanStack anyway

Three bounded things, none of them a dependency on the write path:

1. **`db-ivm` only if we want joins.** Our client live query is already incremental
   (see §5), so db-ivm is not an upgrade from re-run — it is an upgrade from
   single-table to multi-way. Scope the spike to that question: do our real queries need
   joins across collections, and does an operator graph survive Hermes? If the answer to
   the first is no, this line closes permanently.
2. **Their framework adapters as a template.** We have React only. `svelte-db`,
   `solid-db`, `vue-db` and `angular-db` are small and show exactly how to expose one
   reactive core to four idioms. Copy the shape, not the package.
3. **Read `indexes/`, `SortedMap.ts` and `virtual-props.ts` before we write our own.**
   Specific, well-tested algorithms for problems our registry will hit as result sets grow.

---

## 8 · The one scenario that flips this

If the **thin, server-authoritative lane became the primary product** — no local engine,
rows pushed from an authoritative relay, mesh as a secondary mode — then TanStack DB is
a *good* fit, because that world does have an overlay and does have a server to
reconcile against, so `mutationFn` stops being a mismatch and starts being the point.

That is a product decision, not a library decision, and it is the opposite of D5. Worth
naming explicitly so that if we ever drift toward it, we notice we are choosing it rather
than discovering it.

---

## 9 · Housekeeping this raises

`client-interface-proposal.md` still opens with *"the app's data interface **is**
TanStack DB"* and carries no supersession header, which is why this question keeps
returning. Whatever else is skipped, that one header is worth adding — the cost of not
having it is re-litigating this decision every few months.
