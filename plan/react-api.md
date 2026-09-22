---
id: react-api
title: The React surface — what the 2026-09-21 session designed, what shipped, and the gap
status: plan
source: e6dde69a-d7ed-40d0-9f38-d5bac6baf375 · 2026-09-21 (14:54Z–19:38Z), plus every message in the session that names a hook
touches: [react, orpc, client, browser, issues, issues-native]
---

> Written 2026-09-22. Every claim below is anchored to one of four things: a transcript
> timestamp (`2026-09-21T15:46:19Z`), a `path:line` on `t3code/identify-devtools-stack`, a
> commit hash, or a decision id. Timestamps are UTC as recorded in the JSONL; commit dates are
> the author's `+0200`, so `2f4cf11` at 20:09 +0200 is 18:09Z in transcript time.

## 0 · What was read

The transcript between `2026-09-21T14:30:00Z` and `20:30:00Z` — every user message in full,
every assistant message that names a hook — plus every message anywhere in the session
containing `syncmeshReact`, `mesh.Provider`, `useClient`, `whileOpening`, `useStatus`,
`usePeers`, `useSession`, `useRoutes`, `useLinkEvents`, `useOperation`, `useCan`,
`useSoleCustody`, `useSyncOf`, `Diagnosable`, `SyncmeshReact`, `createSyncmeshReact`,
`useApi`, `useActor`, `useDevice`, `useLiveQuery`, `useQuery`, `useMutation`. Two of the
listed names never appear in the transcript at all: `Diagnosable` and `useSoleCustody` (a scan of
all 2,494 user/assistant messages found no message containing either). `whenUnavailable` does
not appear either.

Code: `2f4cf11` (the factory commit), `fadc1c7` (the `answered` refactor), `9a974c4` (coverage on
reads), every file under `packages/react/src`, `packages/react/src/__tests__`,
`apps/issues/src/app`, `apps/issues-native/app` and `apps/issues-native/src/device.tsx`;
`research/syncmesh-book.md` ch. 8–10 (`research/syncmesh-book.md:516-800`) and ch. 30
(`:2013-2028`); `plan/decisions/D26.md`, `D27.md`, `D32.md`; `plan/api-gaps.md` §2.6 and §6.

## 1 · The API as the session designed it

The session arrived at the factory in six turns, each one a user rejection. Members are listed
in the order they were settled; the status column is **decided** (the user said so, or it landed
in the same session without objection), **proposed only** (the assistant offered it and nothing
followed), or **deferred** (parked in words — "later", "not done", "leave that for now").

### 1.1 The starting position, and what the user rejected on the way

| Timestamp | Member | Status | Evidence |
| --- | --- | --- | --- |
| `2026-09-21T15:05:51Z` | **"There is no provider.** `api` is already bound to its mesh, so a descriptor carries everything a subscription needs. You import `api` and use it." `useLiveQuery(api.books.list({ page: 1 }))` returning `{ data, hasAnswered, isSettled }`; `{ enabled: tabVisible }` option; `useCan(api.products.create.can({ shopId }))`; `usePresence(api.$presence, "cursors")`; writes as `api.issues.create(…)` with `.committed` and `.waitFor({ milestone: "replicated", remoteCopies: 2, … })` | superseded — the provider position reversed at `15:34:06Z`; `waitFor` deleted by D27 (`plan/decisions/D27.md:66`) | the full consumer surface as first shown |
| `2026-09-21T15:27:25Z` | The library is five hooks: `useLiveQuery` `useQuery` `useCan` `usePresence` `useOperation` — "Five is the smallest of the four" libraries counted | decided (kept at `15:29:18Z`: every one **Keep**) | count taken "from local copies of each" |
| `2026-09-21T15:27:25Z` | A Suspense sibling — "TanStack DB has `useLiveSuspenseQuery`; LiveStore's `useStore` suspends outright. We don't offer one, and we measured why — `~500ms` blank on the phone. Fine on the web. That's a reasonable future addition to `@syncmesh/react`, as a *sibling* of `useLiveQuery`, not a replacement." | proposed only | never raised again |
| `2026-09-21T15:29:18Z` | `useOperation`: "**Keep, watch it.** … could fold into `useQuery` over `$operations` later" | proposed only | — |
| `2026-09-21T15:29:18Z` | Rename the three non-hooks named `use*`: `useEntropy`/`useSigner` → `supplyEntropy`/`supplySigner` (`@syncmesh/wire`), `useNativeCrypto` → `installNativeCrypto` | proposed only — none renamed (`packages/wire/src/index.ts:100-101` still exports `useEntropy`, `useSigner`; `apps/issues-native/app/_layout.tsx:1,30` still imports and calls `useNativeCrypto`) | — |
| `2026-09-21T15:31:41Z` (user) | "i am apis that the synmesh offers and users must have toe create anyways not app spefic" | the brief | — |
| `2026-09-21T15:32:11Z` | The four every user writes themselves: **"give me the client"** → `useClient()`; **the async-open gate** → `<SyncmeshProvider client={…} whileOpening={…}>`; **sync status** → `useStatus()` over `$status`; **who am I** → `useSession()` over `$auth`. "`useLiveQuery(api.books.list())` still works with an imported `api` and no provider at all. The provider is only for the case where the client *arrives later* — which is every phone." | proposed; the first two reshaped below | — |
| `2026-09-21T15:34:06Z` (user) | "yes i want a provider. the useStatus what else is in the there an dhtis things we need to know about the sync status and so on and the peers and transports we aree connected to" | **decided** | the one explicit yes |

### 1.2 The first build, and the rejection that produced the factory

`2026-09-21T15:43:11Z` — shipped to `dist` as:

```tsx
<SyncmeshProvider client={createClient({ schema, procedures })} whileOpening={<Splash />}>
  <App />
</SyncmeshProvider>

const api = useClient<typeof client>();
```

with five hooks "all reading the `$` surface":

| hook | returns | re-renders when |
| --- | --- | --- |
| `useStatus()` | `health` + per-medium `{ kind, condition, reaches, forced }` | a source changes state, a link is proven or lost |
| `usePeers()` | `{ self, edges[{ peer, over[] }], silent[] }` | same |
| `useLinkEvents(_, keep=50)` | last N `{ kind, transport, peer?, why?, at }`, newest first | every link fact |
| `useSession()` | `{ principal \| null, expiresAt }` | sign-in, sign-out, refresh |
| `useRoutes()` | `[{ to, via, hops, expiresAt }]` | the route table changes |

"Every one holds its snapshot by value … Every one takes the client as an **optional** argument,
so an app with no provider passes it." And: "**Not done.** Neither demo app is on the provider
yet. The native app hides `$` behind `Device.api` on purpose … and the web app holds a
`FollowerMesh` over a port, not a `Client`."

`2026-09-21T15:44:08Z` (user, quoting `const api = useClient<typeof client>();`): "this would
not work bevcause this means the user has to do this everweher the call useClient taht would not
fly. lets dicusss alternatives befoer writing."

`2026-09-21T15:44:52Z` — three options, ranked by the assistant **1 → 3 → 2**:

1. **Register** — `declare module "@syncmesh/react" { interface Register { client: typeof client } }`, then `useClient()` typed everywhere. "Why I rank it first: zero runtime."
2. **Factory** — "`createSyncmeshReact(client)` returns bound hooks. tRPC's shape."
   ```ts
   export const mesh = syncmeshReact(createClient({ schema, procedures }));   // value or promise
   <mesh.Provider whileOpening={<Splash />}><App /></mesh.Provider>
   const api = mesh.useClient();
   const { health } = mesh.useStatus();
   ```
3. **Client as a value, no provider** — "the provider exists only because `createClient` is
   async … `whileOpening` becomes `useStatus().health === "opening"`."

`2026-09-21T15:45:49Z` (user): "is we do number 2 why do we need to call useClient for ?"

### 1.3 What was decided

| Timestamp | Member | Status |
| --- | --- | --- |
| `2026-09-21T15:46:19Z` | **`mesh.api` is a property, not a hook.** "`useClient` did exactly one thing: re-render when the client *arrives*. But under the factory the Provider already gates the tree … a hook that 'subscribes' to it is subscribing to something that will never change again." `useClient` — gone. Register — unnecessary. | **decided** |
| `2026-09-21T15:46:19Z` | **The rule:** "the client is one object for the life of the process, and everything that changes underneath it is a `$` surface with a subscription." Sign-in is `$auth` moving; a leader handover is a port swapping behind a façade. | **decided** |
| `2026-09-21T15:46:19Z` | "`mesh.api` **before** the Provider has rendered is the one hazard … Make it throw with a sentence — 'the mesh has not opened; read it under `<mesh.Provider>`' — rather than return `undefined`." | **decided**; shipped as `packages/react/src/factory.ts:109-116` |
| `2026-09-21T15:46:33Z` | **The test for any new hook:** "does the value change while the component is mounted? … **a hook per thing that moves, a property for everything that doesn't.**" | **decided** |
| `2026-09-21T15:47:17Z` | `mesh.useStatus()` → `{ health, sources }`; `sources.get(name)` → `{ kind, condition, reaches, forced }`; `health` → `"local-ready" \| "catching-up" \| "offline" \| "blocked-recovery"`. Same for `mesh.usePeers()`, `mesh.useLinkEvents()`, `mesh.useSession()`, `mesh.useRoutes()`. | **decided** |
| `2026-09-21T15:47:17Z` | "`MeshHealth` has no `"opening"` … I'd add `"opening"` to the union now" | proposed → **deliberately not done** at `15:52:48Z` ("It goes in when `createClient` returns a value and actually emits it") → **done** at `16:23:36Z` ("`$status.get().health === "opening"` — a new word in the vocabulary, because now something emits it"); `packages/client/src/status.ts:22-27` |
| `2026-09-21T15:48:01Z` (user) / `15:48:18Z` | "we should sue the name of the tranport as ids" → `sources` already keyed by transport name; proposal to make names **literal types** via the factory (`Transport<N>`, tuple kept by `createClient`) | proposed only |
| `2026-09-21T15:49:58Z` (user) / `15:50:23Z` | "why do let the users define the id / ble -> ble / lan -> lan" → **kind is the name** (`sources.get("ble")`), `id` → `room`, no `name` option; "touches `TransportKind` as the key type in `$status`/`$peers`/`LinkEvent`, the three builders' options, and both apps' `wifi.ts`/`ble.ts`" | **deferred by the user** — `2026-09-21T15:50:53Z`: "okay leave that for now can you work on the other things ?" |
| `2026-09-21T15:52:48Z` | **Landed.** "Factory landed, `useClient` gone, 23 tests pass … The five diagnostic hooks come bound — `mesh.useStatus()`, `mesh.usePeers()`, `mesh.useLinkEvents()`, `mesh.useSession()`, `mesh.useRoutes()` — and the standalone forms take the client as a **required** argument for anyone not using the factory." | **decided** (note: `15:43:11Z` had said *optional*; the shipped forms are required — `packages/react/src/use-status.ts:96`, `use-peers.ts:44`, `use-links.ts:28`, `use-session.ts:33`, `use-routes.ts:35`) |
| `2026-09-21T15:52:48Z` | **"Where the `Provider` context went — Nowhere — there isn't one.** `Provider` only gates; it renders children when the store says ready and nothing else. No `createContext`, no `useContext`. The factory's closure *is* the store." | **decided**; see §4 |
| `2026-09-21T15:52:48Z` | "**Wiring the demo apps** — untouched. Native hides `$` behind `Device.api` on purpose; web holds a `FollowerMesh`, not a `Client`. Each is a separate decision." | **deferred** |
| `2026-09-21T15:55:30Z` / `15:56:54Z` | **The pill** — "One component over `mesh.useStatus()`: `catching-up` → *Syncing…*; `offline` → *Offline — changes are saved here*; relay source `connecting-failed` / `temporarily-unavailable` → *Reconnecting…*; `local-ready` → nothing." Also **B** move the gate ("`Provider` around screen bodies, not the navigator"), **C** first-launch screen (`hasAnswered && data.length === 0 && !isSettled`), **D** overrule toast over `$operations` corrections, **E** client as a value. "A–D are screens over hooks that exist: an afternoon, both apps. E is the week." | E **decided and built** (`16:04:29Z` user "do all" → `16:23:36Z`); A **wanted, not built** — restated as not done at `16:23:36Z`, `17:47:01Z` (#3), `18:12:24Z`, `18:31:05Z` (#2 "`useStatus` is drawn **nowhere**"); B, C, D **proposed only**, never raised again |
| `2026-09-21T16:23:36Z` | **The client is a value.** `createClient({ schema, procedures })` returns synchronously; reads pending (`hasAnswered: false`); writes wait; `$ready` "is the promise a *script* awaits; a screen never does"; a refused open rejects `$ready` and every `$` surface throws that reason. | **decided**; `packages/orpc/src/client.ts:40-108` |
| `2026-09-21T18:12:24Z` | **"The new pattern"** in full: (2) `export const mesh = syncmeshReact(createClient({ schema: schema(), procedures, storage: sqlite({ driver }), transports: […] }))` — no `await`; (3) `<mesh.Provider whileOpening={<Splash />}><App /></mesh.Provider>` — "One gate, at the root"; (4) `useLiveQuery(mesh.api.issues.list({ workspaceId }))`; (5) `await mesh.api.issues.create({…}).committed`; (6) `mesh.useStatus()` with `health → "opening" \| "catching-up" \| "local-ready" \| "offline" \| "blocked-recovery"`, `mesh.usePeers()`, `mesh.useLinkEvents()`, `mesh.useSession()`, `mesh.useRoutes()`. "**`mesh.api` is a property. Everything that moves is a hook.**" "What the pattern does *not* yet include: The pill." | **decided** |
| `2026-09-21T18:15:06Z` (user) → `18:26:55Z` | `hasAnswered`/`isSettled` → **`answered: "none" \| "local" \| "settled"`**. Rejected on the way: `storeAnswered`/`sourcesAnswered` (`18:15:22Z`, user `18:24:10Z` "this still does not make sense"), `"nothing" \| "here" \| "everywhere"` (`18:24:27Z`, user `18:26:47Z` "here ???"). The reason: "**The local store is the first source** … `isSettled` is about sources *including* the store … A **subset**, not a sibling" (`18:24:27Z`). User `18:31:37Z`: "you need to build number one". | **decided and built** — `18:34:36Z`, commit `fadc1c7`; "`useQuery` had the same split under different names — `isReady` beside a `coverage` union — so that collapsed too, and the `Coverage` type is gone" |
| `2026-09-22T06:55:09Z` | **`keepPrevious`** — "`useQuery(call, { keepPrevious: true })` holds the last key's rows across the change, with a distinct `answered` state so the UI is never told stale rows are the new answer. This is the real fix … it belongs in `@syncmesh/react` rather than in each app … needs the vocabulary question settled first: is a stale answer a fourth `Answered` value, or a separate `isPlaceholder` flag beside it?" | **proposed, awaiting the user** — the user's next message (`06:56:14Z`) is about `meshApi`, not this |
| `2026-09-22T06:56:50Z` | Three pieces against ch. 9: (1) make the descriptor thenable and namespace the adapter surface under `~mesh`; (2) restore `coverage` beside `answered`; (3) then `keepPrevious` "falls out". "Was the `answered` collapse a decision … or drift that the book still governs?" | (2) **built** the same day — `plan/api-gaps.md:404` "§2.6 coverage on reads — **done**", commit `9a974c4`; (1) and (3) **unanswered** |

### 1.4 Names that did not come from this session

- **`useApi` / `useActor` / `useDevice`** are app plumbing, not library: `2026-09-21T15:27:25Z`
  "Now it has three app-level hooks — `useApi`, `useActor`, `useDevice` — each returning exactly
  one thing"; `15:25:50Z` on `useActor`: "**Demo plumbing for the identity picker** … not part of
  syncmesh." `15:43:11Z`: "`useSession` is the principal the issuer signed, not an actor a picker
  chose. The demo's `useActor` stays app-side, deliberately." The web app received the same
  split at `18:11:58Z` ("`useApi` · `useFollower` · `useTab`").
- **`Diagnosable`**, **`whenUnavailable`** and **`SyncmeshReact`** (the type) are code-only:
  `packages/react/src/factory.ts:61`, `:67`, `:71`. `createSyncmeshReact` was the name in the
  option list at `15:44:52Z`; the shipped name is `syncmeshReact` (`factory.ts:88`).
- The pre-window design that the book records: `2026-09-05T23:41:05Z` "**Mutations resolve at
  local commit, and there is deliberately no `useMutation`** … per-row and reactive:
  `useSyncOf(api.$sync, "books", id)`"; `2026-09-05T23:58:17Z` (user) rejected `useSyncOf`
  ("it doesn't make any sense at all"); `2026-09-06T00:01:17Z` "**Per-row sync: it's a column
  now, not a lookup** … `useOperation(client.$operations.get(id))` takes one subscribable ref, and
  `useCan(client.$can.insert(tables.products))` replaces `"products.insert"`. The general rule is
  now rule 6 in the doc: hooks take one descriptor, descriptors are built from typed references,
  never from a string"; `2026-09-11T16:52:26Z` (user) on `$can.insert(tables.products)`: "this
  complete rubbish because we are never ever going to be accessing the tables direclty on the
  client"; `2026-09-11T16:53:44Z`: `useCan(client.products.create.can({ shopId }))` — "**`$can`
  leaves the `$`-surface table entirely.**"

## 2 · What shipped

### 2.1 The public surface of `@syncmesh/react` — `packages/react/src/index.ts:1-23`

| Export | Kind | Defined at | Shape |
| --- | --- | --- | --- |
| `useLiveQuery` | hook | `use-live-query.ts:130-133` | `(call: LiveCall<T> \| undefined, options?: QueryOptions) => LiveResult<T>` |
| `LiveCall`, `LiveResult`, `QueryOptions` | types | `use-live-query.ts:16-27`, `:51-94`, `:39-48` | `LiveResult = { data, status: "pending"\|"error"\|"success", isPending, isError, isSuccess, answered: Answered, coverage: ReadCoverage, error }`; `QueryOptions = { enabled? }` |
| `useQuery` | hook | `use-query.ts:96` | `(call, options?) => QueryResult<T>` |
| `QueryResult` | type | `use-query.ts:11-42` | `{ data: readonly T[] \| undefined, status: "pending"\|"error"\|"success"\|"disabled", answered, coverage, isEnabled, error }` |
| `Answered` | type | `answered.ts:8` | `"none" \| "local" \| "settled"` |
| `usePresence`, `PresenceTopic` | hook | `use-presence.ts:19` | `(topic: PresenceTopic<P>) => readonly P[]` |
| `useCan`, `CanCall`, `CanSource` | hook | `use-can.ts:47-48` | two overloads: `(source: CanSource<R>, what: \`${string}.${string}\`, row?: R)` **and** `(rehearsal: CanCall)` |
| `useOperation`, `OperationRecord`, `OperationSource` | hook | `use-operation.ts:58-61` | `(source: OperationSource<O> \| undefined, id: string \| undefined) => O \| undefined`; `OperationRecord = { id, label, status: "applied"\|"blocked"\|"superseded", correction? }` (`:4-9`) |
| `syncmeshReact`, `SyncmeshReact`, `ProviderProps`, `Diagnosable` | factory | `factory.ts:88`, `:71-84`, `:63-69`, `:61` | `syncmeshReact<C extends Diagnosable>(client: C \| Promise<C>) => { api: C (getter, throws), Provider({ whileOpening?, whenUnavailable?, children }), useStatus, usePeers, useLinkEvents(keep?), useSession, useRoutes }`; `Diagnosable = StatusSource & PeersSource & LinksSource & SessionSource & RoutesSource` |
| `useStatus`, `Reading`, `Source`, `StatusSource` | hook | `use-status.ts:96`, `:38-43`, `:20-36`, `:7-17` | `(client: StatusSource) => Reading { health: MeshHealth, sources: ReadonlyMap<string, Source> }`; needs `$status` **and** `$transports.{list,onLinkEvent,forced}` |
| `usePeers`, `PeersSource` | hook | `use-peers.ts:44`, `:7-13` | `(client) => PeerGraph`; needs `$peers.graph`, `$transports.onLinkEvent`, `$status.subscribe` |
| `useLinkEvents`, `LinksSource` | hook | `use-links.ts:28` | `(client, keep = 50) => readonly LinkEvent[]` |
| `useSession`, `SessionSource` | hook | `use-session.ts:33` | `(client) => AuthStatus`; needs `$auth.{status,subscribe}` |
| `useRoutes`, `RoutesSource` | hook | `use-routes.ts:35` | `(client) => readonly Route[]`; needs `$routes.{all,onChange}` |

Absent, and correctly so: no `useMutation` (D26 §8; `research/syncmesh-book.md:799-800`, `:2010`),
no `useClient` (`2026-09-21T15:52:48Z`), no `useSyncOf` (removed from the package in `6629c01`,
2026-09-13), no `createContext`/`useContext` anywhere in `packages/react/src` (the factory holds
its state in a closure — `factory.ts:89-107`).

The factory's `Provider` accepts a value or a promise (`factory.ts:86-101`), draws
`whileOpening` (default `null`) until settled, `whenUnavailable?.(error)` on rejection, and
withholds children otherwise (`factory.ts:118-127`). `api` is a getter that throws with
`"the mesh has not opened yet — read \`api\` under <Provider>, not at module scope"` before the
promise settles (`factory.ts:109-116`). Its doc block states the design rule verbatim: "**`api`
is a property, not a hook**, and that is the whole design" (`factory.ts:31`) and "**Deliberately
not `use()` and not Suspense** … on a phone that measured as ~500ms of nothing at all"
(`factory.ts:44-46`).

What `2f4cf11` added: `factory.ts` (140 lines), `use-links.ts`, `use-peers.ts`, `use-routes.ts`,
`use-session.ts`, `use-status.ts`, `__tests__/factory.test.ts` (304 lines), `__tests__/mount.ts`,
twelve `index.ts` export lines — plus, unrelated to React, the WAL pragmas in
`adapters/sqlite-wasm/src/vfs.ts` (`git show 2f4cf11 --stat`). `fadc1c7` (20:34 +0200) then added
`answered.ts` and rewrote `use-live-query.ts` / `use-query.ts` to one `answered` field;
`9a974c4` (2026-09-22) added `coverage` to both hooks.

### 2.2 What is pinned by tests

`packages/react/src/__tests__/factory.test.ts`: a promised client draws `whileOpening` then the
tree with `api` underneath (`:119`); a value client is there on the first frame and
`whileOpening` never draws (`:151`); a refused open draws its reason and `api` throws with it
(`:171`); the bound hooks read the factory's client (`:191`); `useStatus` holds its snapshot and
counts `reaches` (`:208`); `usePeers` gains an edge on `proven` and names silent media (`:238`);
`useLinkEvents` newest-first, bounded (`:253`); `useSession` re-renders on sign-in only (`:266`);
`useRoutes` learns a route (`:286`). **All against a hand-built fake** — "Nothing here opens an
engine" (`factory.test.ts:20-27`), the fake at `:48-105` carrying `$auth`, `$peers`, `$routes`,
`$status`, `$transports` and nothing else. No test constructs `syncmeshReact(createClient(…))`.

`__tests__/hooks.test.ts`: `useLiveQuery` one render per change (`:72`); `useCan` flips on a
grant and rehearses once per key (`:120`, `:152`); `useOperation` reads once per id (`:184`); 200
live queries over a 5,000-event catch-up (`:244`); `usePresence` (`:314`); coverage walks
`local-only → partial@nearby → caught-up@internet` and a call without coverage reads `local-only`
(`:360`, `:411`); `useQuery` disabled → local → settled, a thrown read never answers,
`enabled: false` opens nothing, no-call and `enabled: false` agree (`:430`, `:481`, `:515`,
`:584`). `__tests__/api-live.test.ts`: `useLiveQuery` over `api.*` re-renders on a write (`:92`),
`api.$can` gates a button (`:127`), a row's reach arrives with the row (`:139`), refused input
never reaches the table (`:170`).

### 2.3 What the apps call

**`apps/issues` (web)** — imports from `@syncmesh/react`: `useLiveQuery`
(`src/app/workspace.tsx:3,35-39`; `chrome.tsx:4,178`; `people.tsx:1,99-100`; `sidebar.tsx:3,91`;
`thread.tsx:1,39,169,238,241`), `useQuery` (`use-issues.ts:3,71,96`; `detail.tsx:1,238`),
`useCan` — both forms: the rehearsal `useCan(api.issues.remove.can({…}))` (`detail.tsx:263`) and
the string form `useCan(api.$can, "issue.update")` (`detail.tsx:264`), `useOperation(mesh.operations, id)`
(`list.tsx:3,113`; `sync-badge.tsx:1,41`), and the types `QueryResult`, `OperationRecord`,
`Answered` (`use-issues.ts:1`, `sync-note.ts:2`, `view.ts:1`). The client reaches screens through
the app's own context: `useApi = () => held().api` (`context.ts:88-89`), `useFollower`,
`useTab`, `useActor` (`context.ts:89-118`), provided by `<ReplicaHeld value={replica}>`
(`workspace.tsx:59`) under `<Workspace key={held.epoch} …>` (`main.tsx:192`) — the epoch remount
the session named at `2026-09-21T15:13:19Z`. Relay reachability is a `BroadcastChannel` fact
(`reach.ts:1-13`), not a hook. **No call to `syncmeshReact`, `mesh.Provider`, `useStatus`,
`usePeers`, `useLinkEvents`, `useSession` or `useRoutes`** (a grep of `apps/`, `packages/devtools/src`
and `adapters/` for those names returns nothing outside `packages/react`).

**`apps/issues-native`** — `useLiveQuery` (`app/index.tsx:5,100-120`; `identity.tsx:5,32`;
`people.tsx:3,33-34`; `settings.tsx:2,31`; `workspace.tsx:4,27-29`; `issues/new.tsx:2,43-44`) and
`useCan` in the **string form only** — six calls `useCan(api.$can, "team.insert")` etc.
(`app/workspace.tsx:31-36`). The gate is the app's own `MeshGate` over `useSyncExternalStore`
(`src/device.tsx:60-73`), mounted above the navigator (`app/_layout.tsx:53-55`) with
`whileOpening={<Blocked spinner>Opening the local database…</Blocked>}` — the exact prop names
the factory later took. `useApi`, `useActor`, `useDevice` are context reads off `Device`
(`device.tsx:33,41,44`). `Device.api` is `Api<typeof procedures>` — "narrowed to the procedures
on purpose — a screen has no business reaching the transports" (`src/mesh.ts:149,252-253`).
Health is read by hand on the devtools screen — `const { health } = instruments.status()`
(`app/devtools.tsx:107`) — not through `useStatus`. **No call to `syncmeshReact`.**

**Why neither can, today.** `syncmeshReact<C extends Diagnosable>` (`factory.ts:88`) requires
`$status`, `$transports`, `$peers`, `$auth`, `$routes`. `Client<R>` from `createClient` has all of
them (`packages/orpc/src/client.ts:53-61,69`). The web app's client is a `FollowerClient<R>`,
which has only `$mesh`, `$operations`, `$inspect`, `$flush`, `$ready`, `$close`
(`adapters/browser/src/client.ts:250-261`). The native app has the right client type but hides it
behind `Device` (`src/mesh.ts:148-149`).

## 3 · The gap list

Size: **S** one file or one package, an afternoon; **M** two or three packages or a decision
inside it; **L** needs a mesh-side surface or a decision that does not exist yet. "Mesh first"
names the non-React thing that has to exist before the hook can.

| # | What | Specified | Why it is missing | Touches / mesh first | Size |
| --- | --- | --- | --- | --- | --- |
| G1 | **The apps on the factory** — `syncmeshReact(client)` + `mesh.Provider` replacing `MeshGate` (native) and `ReplicaHeld` + `key={epoch}` (web) | `2026-09-21T15:43:11Z` "Not done"; `15:52:48Z` "Wiring the demo apps — untouched … Each is a separate decision"; `18:12:24Z` presents it as "the new pattern" | **deferred** in the session; **blocked** for web by `FollowerClient` lacking the five `$` members (`adapters/browser/src/client.ts:250-261`) and for native by `Device.api` being narrowed (`apps/issues-native/src/mesh.ts:149,252-253`) | `adapters/browser` (forward `$status`/`$transports`/`$peers`/`$auth`/`$routes` over the port, or a narrower `Diagnosable`), `apps/issues`, `apps/issues-native` | M |
| G2 | **The pill** — one component over `mesh.useStatus()`: *Syncing… / Offline / Reconnecting* | `2026-09-21T15:56:54Z` (A); `16:23:36Z` "neither app draws the pill yet"; `17:47:01Z` #3 "nothing draws it. The hooks exist purely for me"; `18:31:05Z` #2 | never started; depends on G1 | both apps; possibly a shared component in `@syncmesh/react` (the session put it in the apps: "One component over `mesh.useStatus()`") | S |
| G3 | **Gate the screen bodies, not the navigator** — `whileOpening` "becomes a spinner inside a list, not a splash over the app" | `2026-09-21T15:55:30Z`; `15:56:54Z` (B) | native still gates above `<Stack>` (`apps/issues-native/app/_layout.tsx:53-55`); the session then argued E makes `whileOpening` "stop existing" (`16:03:34Z`) yet `18:12:24Z` keeps `<mesh.Provider whileOpening>` at the root — **flagged: which of B and E's consequence is intended is not stated** | apps | S |
| G4 | **First-launch screen** (C) and **overrule toast** over `$operations` corrections (D) | `2026-09-21T15:56:54Z` | proposed once, never raised again | apps, over `answered` (`use-live-query.ts:84`) and `useOperation` (`use-operation.ts:58`) | S each |
| G5 | **`keepPrevious`** on `useQuery`/`useLiveQuery` — hold the last key's rows across a key change with a distinct `answered` state | `2026-09-22T06:55:09Z` (3); `06:56:50Z` (3) | awaiting the user's call — "fourth `Answered` value, or a separate `isPlaceholder` flag"; no reply in the transcript; `grep keepPrevious packages/react/src apps` → nothing | `packages/react` (`use-live-query.ts`, `use-query.ts`, `answered.ts`); precondition (2) "restore `coverage` beside `answered`" is **met** (`plan/api-gaps.md:404`, `9a974c4`) | M |
| G6 | **`state: ReadonlyMap<RowKey, T>`** and `status: "idle"` on `useQuery` | book `research/syncmesh-book.md:629-633`; adopted at `2026-09-06T00:05:31Z` ("`state` is a keyed Map") | not in `QueryResult` (`packages/react/src/use-query.ts:11-42`); `LiveSnapshot` carries only `data: readonly T[]` (`packages/drizzle/src/live.ts:17-32`); not discussed on 09-21 | `packages/drizzle` (a keyed map on the snapshot), `packages/react` | M |
| G7 | **Keyed diff `{ added, removed, changed }` on every delivery** — the book's fourth live invariant | book `:620-623` | `LiveListener` receives `changes?: LiveChange<T>[]` **only when the query was maintained**, `undefined` on a re-run (`packages/drizzle/src/live.ts:34-43`); the hook exposes nothing of it (`use-live-query.ts:51-94`) | `packages/drizzle`, `packages/react` | M |
| G8 | **`useOperation` takes one ref** — `useOperation(client.$operations.get(operationId))` — and returns the full record (`replication.receipts`, `targetMet`, `blockers`) | book `:769`, `:1737`, rule at `:775-778`; `2026-09-06T00:01:17Z` "takes one subscribable ref"; D27 `:79-83` (`w.status()`, `w.subscribe()`) | shipped signature is `(source, id)` (`use-operation.ts:58-61`) and `OperationRecord` is `{ id, label, status, correction? }` (`:4-9`); `15:29:18Z` "could fold into `useQuery` over `$operations` later" was proposed only | **mesh first:** `$operations.get(id)` returning a subscribable ref (`packages/orpc/src/client.ts:52` exposes `Mesh["operations"]`); then `packages/react`, `apps/issues` (`list.tsx:113`, `sync-badge.tsx:41`) | M |
| G9 | **Drop the string form of `useCan`** — `useCan(api.$can, "issue.update")` — and `Api.$can` with it | book `:775-778` "never from a string naming something the type system already knows"; `2026-09-11T16:52:26Z` (user); `16:53:44Z` "`$can` leaves the `$`-surface table entirely"; row-level form in book `:1110` `client.products.update.can({ id: row.id })` | shipped and in use: overload at `use-can.ts:47`, `Api.$can` at `packages/orpc/src/api.ts:150-151`, callers `apps/issues/src/app/detail.tsx:264`, `apps/issues-native/app/workspace.tsx:31-36`; the hook's own doc defends keeping it ("what a row-level affordance inside a list wants", `use-can.ts:31-32`) — **flagged: the book and the hook disagree, and no 09-21 message resolves it** | `packages/orpc` (`$can`), `packages/react` (`useRule`, `CanSource`), both apps (six native calls become `.can({…})` rehearsals — every mutation already has `.can`, `api.ts:159-161`) | M |
| G10 | **Delete `Api.$sync` / `SyncSource`** — a dead surface whose doc names a hook that no longer exists | book `:724-744` "Row state is a column, not a lookup"; user `2026-09-05T23:58:17Z`; `syncOf`/`operationOf` built (`packages/drizzle/src/sync-of.ts:26,62`; `plan/api-gaps.md:372`) | `packages/orpc/src/api.ts:112-119,152-153` still declares `SyncSource` and `$sync` with "`useSyncOf(api.$sync, …)` reads it"; `useSyncOf` left `packages/react` in `6629c01` (2026-09-13); exported at `packages/orpc/src/index.ts:24` | `packages/orpc` (and whatever in `packages/client` implements `SyncSource.at`) | S |
| G11 | **`useSoleCustody`** + `mesh.custody.sole()` / `mesh.custody.subscribe(…)` — "3 writes only on this device" gating destructive actions | D27 `:69` "**later** — wanted, but gated on the compaction question"; `:74`, `:86-87`, `:101-102` | **explicitly deferred** by D27; never mentioned in the transcript; no `custody` member on the client (`grep custody packages/client/src packages/orpc/src` → doc comments and the server-side `serveCustody` only) | **mesh first:** `mesh.custody.sole()` with a cached count (D27 `:101`), the compaction check (D27 `:108`); then `packages/storage`, `packages/orpc`, `packages/react` | L |
| G12 | **Render `refused-by`** — a quarantine report reaching the author's screen | D32 `:153-159` (surfaces), `:188-190` "`@syncmesh/react` (whatever renders `refused-by`)" | D32 is `status: draft`, `decided: —` (`plan/decisions/D32.md:1-6`); needs the wire receipt, the frame, the table and `refusalsOf` first | `packages/wire`, `transport`, `storage`, `client`, then `react` | L |
| G13 | **Thenable `Query<T>` with the adapter surface under `~mesh`** — the hook reads `key`/`live`/`settled`/`coverage`/`onCoverage` off the public descriptor today | book `:580-590`, `:652-655`; `2026-09-22T06:56:50Z` piece (1) — "the code is simply behind the book rather than disagreeing with it" | unanswered by the user; `QueryCall` is not thenable and unmarked (`packages/orpc/src/api.ts:75-89`); `LiveCall` binds to those public names (`use-live-query.ts:16-27`) | `packages/orpc`, `packages/react` (`LiveCall`), `packages/tanstack-db` | M |
| G14 | **Transport kind as the name** — `sources.get("ble")` typed as `TransportKind`, `id` → `room`, no `name` option | `2026-09-21T15:48:18Z`, `15:50:23Z` | **parked by the user** `15:50:53Z`; restated as parked in the `19:18:00Z` summary | `packages/transport` builders, `packages/client` (`$status`/`$peers` key type), `packages/react` (`Reading.sources` "Keyed by the transport's own name", `use-status.ts:41-42`), both apps' `wifi.ts`/`ble.ts` | M |
| G15 | **A Suspense sibling** of `useLiveQuery` | `2026-09-21T15:27:25Z` "a reasonable future addition … as a *sibling*" | proposed only; nothing decided; the factory's own doc rejects Suspense for the *gate*, not for a query hook (`factory.ts:44-46`) | `packages/react` | S |
| G16 | **Rename the three setters named `use*`** — `useEntropy`/`useSigner` → `supplyEntropy`/`supplySigner`, `useNativeCrypto` → `installNativeCrypto` | `2026-09-21T15:29:18Z` "Rename … Cheap, no behaviour change" | proposed only; not done (`packages/wire/src/index.ts:100-101`; `apps/issues-native/app/_layout.tsx:1,30`) | `packages/wire`, `packages/react-native`, `apps/issues-native` | S |

### 3.1 Divergences that are decided, not gaps

| What the book / D26 says | What shipped | Decided where |
| --- | --- | --- |
| `useQuery` returns `isReady` + `coverage` (book `:629-644`); `useLiveQuery` returns `isSettled` (D26 §5, `plan/decisions/D26.md:71`) | one `answered: "none" \| "local" \| "settled"` on both hooks (`answered.ts:8`; `use-live-query.ts:84`; `use-query.ts:28`), **and** `coverage` beside it (`use-live-query.ts:92`; `use-query.ts:39`) | `2026-09-21T18:24:27Z`–`18:34:36Z`, commit `fadc1c7` ("They were never two subjects … A **subset**, not a sibling"); `coverage` restored additively by `9a974c4` — `plan/api-gaps.md:232-234` "`answered` stays exactly as D26 §6 specified, and `coverage` is the richer fact beside it". `use-query.ts:15-27` records the rejection of `isReady` in its own doc. |
| `useStatus(client.$status)` returns `health` (book `:1750`) | `useStatus(client: StatusSource)` needs `$status` and `$transports`, returns `{ health, sources }` with per-medium `{ kind, condition, reaches, forced }` (`use-status.ts:7-43`) | `2026-09-21T15:34:06Z` (user asked for "the peers and transports we are connected to"), `15:43:11Z` table, `15:47:17Z` |
| The diagnostic hooks "take the client as an optional argument" (`2026-09-21T15:43:11Z`) | required argument on every standalone form (`use-status.ts:96`, `use-peers.ts:44`, `use-links.ts:28`, `use-session.ts:33`, `use-routes.ts:35`) | `2026-09-21T15:52:48Z` "the standalone forms take the client as a **required** argument" |
| `@syncmesh/react` exports `useQuery`, `useOperation`, `useCan` (book ch. 30, `:2024`) | plus `useLiveQuery`, `usePresence`, `syncmeshReact` and the five diagnostic hooks (`index.ts:1-23`) | `2026-09-21T15:29:18Z` all five kept; `15:34:06Z` the rest asked for. The book's list predates the session (ch. 25 "audited 2026-09-08", `:1828`). |
| `LiveResult` has React Query's `isPending`/`isError`/`isSuccess` (D26 §5) | kept (`use-live-query.ts:54-57`); `QueryResult` drops them for TanStack DB's `status`/`isEnabled` (`use-query.ts:14,40`) | D26 §5 for `useLiveQuery`; book `:629-635` for `useQuery`; `2026-09-06T00:05:31Z` |

### 3.2 Shipped that the session or the book said should not exist

| Item | Where | Why it should not | Status |
| --- | --- | --- | --- |
| `useCan(source, "table.op", row?)` and `Api.$can` | `packages/react/src/use-can.ts:47`; `packages/orpc/src/api.ts:150-151`; callers `apps/issues/src/app/detail.tsx:264`, `apps/issues-native/app/workspace.tsx:31-36` | book `:775-778`; `2026-09-11T16:52:26Z` (user); `16:53:44Z` | G9 |
| `Api.$sync`, `SyncSource`, the `useSyncOf` reference | `packages/orpc/src/api.ts:112-119,152-153`; `packages/orpc/src/index.ts:24` | book `:724-744`; `2026-09-05T23:58:17Z` (user); the hook itself was removed in `6629c01` | G10 |
| `useMutation` | **absent** — not in `index.ts:1-23` | D26 §8 (`plan/decisions/D26.md:91`); book `:799-800`, `:2010` | verified absent |
| `useClient` | **absent** — deleted before `2f4cf11` | `2026-09-21T15:46:19Z`, `15:52:48Z` | verified absent |
| a `createContext` provider | **absent** — the factory is a closure (`factory.ts:89-107`) | D26 §10 (`plan/decisions/D26.md:104-109`); `2026-09-21T15:52:48Z` | verified absent; see §4 |
| `Write.waitFor` / `remoteCopies` (shown at `2026-09-21T15:05:51Z`) | **absent** | D27 `:66`, `:94` | verified absent (`plan/api-gaps.md:373`) |

## 4 · D26 §10 "no provider" against the factory's `Provider`

D26 §10 (`plan/decisions/D26.md:104-109`):

> **And no provider.** One was drafted, on the reasoning that a component should not thread a
> handle — which is true, and is why the old `useLiveQuery(handle, query)` had to go. But
> `meshApi` binds the mesh at construction, so the descriptor already carries everything the
> subscription needs and there is nothing left for a context to supply. React Query needs
> `QueryClientProvider` because it owns a cache; we have no cache, because the fold is the
> invalidation. A provider here would exist only to be imported.

The factory (`packages/react/src/factory.ts:37-42`):

> The client may be a promise. On a phone, opening SQLite is I/O that must not stand between
> launch and the first frame, so {@link SyncmeshReact.Provider} draws `whileOpening` until it has
> answered and withholds the tree until then — which is exactly what makes `api` safe to read
> as a property underneath it.

And `use-live-query.ts:111-112`, unchanged by the session: "There is no provider and nothing to
thread: `api` is already bound to its mesh, so the descriptor carries everything the subscription
needs."

**The resolution the session reached, at `2026-09-21T15:52:48Z`:**

> **Where the `Provider` context went — Nowhere — there isn't one.** `Provider` only gates; it
> renders children when the store says ready and nothing else. No `createContext`, no
> `useContext`. The factory's closure *is* the store. That's what made `useClient` deletable:
> there was never anything to read out of a context that the closure didn't already hold.

So the two texts do not conflict on the thing D26 §10 rejects. D26 §10 rejects a provider that
*supplies* something to a hook — a context the descriptor would otherwise carry — and the shipped
`Provider` supplies nothing: it has no context (`factory.ts:1-15` imports `useSyncExternalStore`
only), the descriptor hooks never read it, and `useLiveQuery(mesh.api.issues.list(…))` works with
or without it. What it does is the one job D26 §10 did not consider: gate a tree on an
asynchronous open. The session's own words for why that job exists: "the provider exists only
because `createClient` is async" (`15:44:52Z`, option 3) and "The provider is only for the case
where the client *arrives later* — which is every phone" (`15:32:11Z`).

**What is left open.** The session then made `createClient` synchronous (`16:23:36Z`), which is
the condition under which it had said the Provider "becomes optional" (`15:44:52Z`) and "never
draws `whileOpening`, and no call site moves" (`15:46:19Z`). The factory still accepts a promise
(`factory.ts:86-101`), the "new pattern" at `18:12:24Z` still shows `<mesh.Provider
whileOpening>` at the root, and the factory doc still describes the promised case (`factory.ts:37`).
Whether `Provider` is now load-bearing (a value client with `$status.health === "opening"`
underneath it draws the tree at once — `factory.test.ts:151`) or a vestige is **not stated
anywhere in the transcript**. Flagged; it is G3's question from the other side.

## 5 · Proposed order

1. **G10** — delete `Api.$sync`/`SyncSource`. One package, no callers, no decision.
2. **G9** — drop the string `useCan` and `Api.$can`. Needs the row-level rehearsal form
   (`api.issues.update.can({ id })`, which `Api` already types at `api.ts:159-161`) in both apps
   first; the six native calls and one web call move. Carries a flagged disagreement between the
   hook's doc and the book — resolve before deleting.
3. **G1** — the apps on the factory. Web is gated on `adapters/browser` forwarding the five `$`
   members over the port; native is a wiring change. Everything in 4 depends on this.
4. **G2 → G3 → G4** — the pill, then the gate placement (which needs the §4 question answered),
   then the first-launch screen and overrule toast. Screens over hooks that exist.
5. **G5** — `keepPrevious`. Needs the user's vocabulary call (`2026-09-22T06:55:09Z`); its stated
   precondition, coverage beside `answered`, is met.
6. **G8, G6, G7** — the read contract from the book: `useOperation` over one ref with the full
   record (mesh first: a subscribable `$operations.get`), then `state` map and keyed diff (drizzle
   first). G13 (`~mesh`) is the same seam and should be decided with them, not after.
7. **G14** — parked by the user; reopen only on the user's word.
8. **G11** — `useSoleCustody`, after D27's compaction question and `mesh.custody.sole()`.
9. **G12** — `refused-by`, after D32 is decided and the wire half exists.
10. **G15, G16** — undecided nice-to-haves; no dependency, no urgency stated.

Counts: S 6 (G2, G4, G10, G15, G16, G3), M 8 (G1, G5, G6, G7, G8, G9, G13, G14), L 2 (G11, G12).
