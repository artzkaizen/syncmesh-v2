# Prior art — automerge-repo, and what to take from it

> Read 2026-08-24 from `automerge/automerge-repo` (the `Repo`, adapters, synchronizer,
> websocket package) and `automerge/automerge` (the Rust sync protocol). Cloned to
> `../syncmesh/internal/exisiting/automerge-repo` and `.../automerge`. This is research:
> patterns worth copying, patterns worth *not* copying, and why. Nothing here is decided.

## The one-paragraph picture

`Repo` is the single object. You construct it with a storage adapter, a list of network
adapters, and a peer id; it builds a `StorageSubsystem`, a `NetworkSubsystem` and a
`CollectionSynchronizer` internally and wires them with events. Adapters are tiny — a
storage adapter is a hierarchical key/value store, a network adapter is "connect, send,
disconnect, tell me about peers" — and each ships with a reusable **acceptance test suite**
that any third-party adapter runs. Sync is a per-document, per-peer state machine driven
by `generateSyncMessage` / `receiveSyncMessage` on the Rust core, using Bloom filters to
summarise "what I have". That is the whole shape, and most of it maps onto ours directly.

---

## 1 · Instantiation — `new Repo(config)`

```ts
const repo = new Repo({
  storage: new IndexedDBStorageAdapter(),            // one, optional
  network: [new BrowserWebSocketClientAdapter(url)], // many, more can be added at runtime
  peerId,                                            // defaults to a random one
  sharePolicy,                                       // async (peerId, docId?) => boolean
  isEphemeral,                                       // DEFAULTS TO `storage === undefined`
  saveDebounceRate: 100,
  flushConcurrency: 20,
})
```

Things to copy:

- **One constructor, one config object, adapters as instances.** No free functions that
  take the repo as their first argument. Subsystems (`StorageSubsystem`,
  `NetworkSubsystem`, `CollectionSynchronizer`) are built *inside* the constructor and
  never exposed as things you assemble.
- **Derived defaults that say something.** `isEphemeral = storage === undefined` — "no
  storage" *means* "do not bother persisting sync state for me". A default that encodes a
  fact rather than a placeholder.
- **Mutually exclusive options throw at construction** (`sharePolicy` and `shareConfig`
  together). Definition-time mistake, definition-time failure.
- **Adapters can be added and removed at runtime** — `repo.networkSubsystem.addNetworkAdapter(a)`.
  We had this on the list (§23 of the API); they have it from the start.
- **The repo waits for each adapter's `whenReady()` before using it**, and the websocket
  client **force-readies itself after 1 s** so a dead network never wedges the repo. Ready
  is a promise, not a boolean you poll.
- **Config comments carry operational advice.** `flushConcurrency`'s doc tells you to tie it
  to the storage's constraining resource — file-descriptor ceiling, ~6 HTTP/1.1
  connections per origin, ~100 HTTP/2 streams. Our API doc should do this.
- **`flush()` and `shutdown()`.** Flush settles even if some saves fail (so it is safe to
  await), with a concurrency cap; shutdown = flush, then close adapters and storage. We
  have `stop()` and no `flush()`; a durable store makes flush meaningful.

## 2 · The network adapter port

```ts
interface NetworkAdapterInterface extends EventEmitter<{
  "peer-candidate": ({ peerId, peerMetadata }) => void
  "peer-disconnected": ({ peerId }) => void
  message: (msg: Message) => void
  close: () => void
}> {
  peerId?: PeerId
  peerMetadata?: PeerMetadata          // { storageId?, isEphemeral? }
  isReady(): boolean
  whenReady(): Promise<void>
  connect(peerId, peerMetadata?): void
  send(message: Message): void
  disconnect(): void
}
```

`Message` is `{ type, senderId, targetId, documentId?, data? }` — the adapter is a byte
pipe addressed by peer id, and it does not know what a sync message is. That is our
`FrameLink` (`send` + `onFrame`) plus peer discovery events.

Things to copy:

- **Peer discovery is the adapter's job, addressed sends are the repo's.** Our frame link
  has no notion of "which peer" — a BLE link is one peer, a relay socket is one peer. The
  moment a transport can reach *many* peers (a relay room, a Wi-Fi Aware cluster),
  `peer-candidate` / `peer-disconnected` / `targetId` is the shape. Worth deciding in D12
  whether the port is "one link = one peer" or "one adapter = many peers". Automerge chose
  the second; ours is the first with a relay doing fan-out on the far side.
- **`PeerMetadata.storageId`.** A peer's *storage* identity is separate from its
  *connection* identity. Sync state is persisted per `storageId`, so a peer that reconnects
  with a fresh connection resumes where it left off. Our cursors are per-author (device
  key), which already survives reconnects — but the idea of "sync state keyed by the thing
  that persists, not the thing that connects" is exactly right and worth naming.
- **An abstract `NetworkAdapter` base class** exists only to supply the event emitter. Same
  as our `FrameTransport`.

Things to *not* copy:

- The websocket client's `send` on a non-OPEN socket **logs and drops**. That is the
  silent-loss shape we rejected: our rule is *send must throw if the frame did not leave*,
  so cursors know to re-request. Their sync protocol tolerates it because Bloom-based
  resync is cheap and in-flight tracking re-sends; ours relies on the transport being
  honest.

## 3 · The storage adapter port

```ts
interface StorageAdapterInterface {
  load(key: string[]): Promise<Uint8Array | undefined>
  save(key: string[], data: Uint8Array): Promise<void>
  remove(key: string[]): Promise<void>
  loadRange(prefix: string[]): Promise<Chunk[]>
  removeRange(prefix: string[]): Promise<void>
  close?(): Promise<void>
}
```

**A hierarchical key/value store of binary blobs, and nothing else.** Keys are
`[documentId, "snapshot" | "incremental", hash]`; the adapter is told to be agnostic to
their meaning. All the intelligence — chunking, compaction, sync-state persistence — lives
in `StorageSubsystem` on top.

Things to copy:

- **Minimal port, smart subsystem.** Their adapter is six methods and an IndexedDB one is
  ~80 lines. Ours is a 15-member `EventStore` with half the members optional and the
  traps in the optional half. We have *one* SQLite store over a 5-method `SqliteDriver`,
  which is the same instinct applied one level down. The question for D05: is a KV port
  under the SQLite store worth it, so IndexedDB / DO KV / R2 are 80-line adapters too?
  The cost is that `allSince(floor)` (the O(log) vs O(state) boot win) needs a range query
  the KV port cannot express.
- **The compaction heuristic, stated in one line:**
  `snapshotSize < 1024 || incrementalSize >= snapshotSize`. Compact when incrementals
  outweigh the snapshot, or when the doc is tiny. Ours is `snapshotEvery: N` — count-based.
  Size-based is closer to what actually costs at boot.
- **`SavedHeads` with a sequence counter** so a compaction that started before an
  incremental save and finished after it does not clobber the newer heads. Concurrent
  writers to one "last saved" value — we will hit this the moment save is async (D05).
- **Every storage event is surfaced as metrics** (`doc-loaded`, `doc-saved`,
  `doc-compacted`) with sizes and durations, re-emitted by the repo as `doc-metrics`. This
  is D17's seam, built in from the start.

## 4 · Contract tests for adapters — the pattern most worth stealing

```ts
runNetworkAdapterTests(async () => ({
  adapters: [new MyAdapter(), new MyAdapter(), new MyAdapter()],   // three peers
  teardown: () => server.close(),
}))
```

`helpers/tests/network-adapter-tests.ts` is an acceptance suite any adapter runs: *can
sync 2 repos · can sync 3 repos · can broadcast · emits peer-candidate with metadata ·
emits disconnect · does not send after disconnect · supports reconnecting*. Storage has
one too: *undefined when empty · round-trip · composite keys · large payload · range load
only matches the prefix · remove range leaves non-matching*.

**Do this for our transport port and our SQLite driver port.** A 20-line BLE adapter
should be able to prove itself by running our suite, and a driver for a new SQLite host
should be provable the same way. This also fixes something we got wrong: the exploration
had two near-identical stores that drifted apart *because nothing ran the same tests
against both*.

## 5 · The sync protocol — Bloom filters vs cursors

Per document, per peer, a `SyncState`:

```rust
shared_heads, last_sent_heads, their_heads, their_need,
their_have: Vec<Have /* heads + BloomFilter */>,
sent_hashes, in_flight, ...
```

`generateSyncMessage` returns `None` when there is nothing to send **or a message is
already in flight**; `receiveSyncMessage` clears `in_flight`. A Bloom filter (10 bits per
entry, 7 probes, ~1 % false positives, parameters carried in the wire so they can change)
summarises "the changes I have" so a peer can compute what the other lacks without listing
every hash. Paper: arxiv 2012.00472.

Why they need it and we do not: automerge's history is a **DAG of content-addressed
changes** with no per-author counter, so "what do you have?" has no compact exact answer.
Ours has per-author monotonic `seqNum`s, so a cursor map `peer → seq` is an **exact**
summary in O(peers) bytes. Keep cursors. Two things to take anyway:

- **`in_flight`.** They never generate a second sync message to a peer until the first is
  acknowledged. We push outstanding events after the last catch-up page and rely on dedup;
  an explicit in-flight flag per peer would stop a reconnect storm from re-sending the
  same batch three times.
- **The protocol is a pure function pair** — `(doc, state) → (state, message?)` and
  `(doc, state, message) → (doc, state)`. No I/O, no clock, testable by feeding messages
  back and forth in a loop (the Rust docs literally do this). Our `Link.catchUp()` is that
  loop; making the per-peer step a pure function would make every transport's sync
  behaviour testable without the transport.

## 6 · Handshake and versioning

```
client → { type: "join", senderId, peerMetadata, supportedProtocolVersions: ["1"] }
server → { type: "peer", senderId, peerMetadata, selectedProtocolVersion: "1" }
       | { type: "error", message }   then close
```

The server picks a version from the client's list or refuses. **This is D14 exactly**, in
~15 lines, and it exists from their v1. A second `join` from the same peer id disconnects
the old socket first — the room-switch leak we found in the exploration, handled.

Server keepalive: an `isAlive` flag per socket, a `ping()` every 5 s, `terminate()` if no
pong came back. Client: a retry interval on close, a `join()` on open. Ours announces the
cadence in `hello` and re-arms a deadline on every frame — stronger for a browser, where
native pings are invisible to the page. Both are fine; ours is documented as to why.

## 7 · Ephemeral messages and presence

```ts
{ type: "ephemeral", senderId, targetId, documentId, sessionId, count, data }
```

`sessionId` (random per process start) + `count` (monotonic) let a gossiping peer drop
messages it has already seen — a `HashRing(1000)` seen-set. `Presence` sits on top: local
state broadcast on change, a heartbeat when idle, a TTL to prune silent peers, a "hello"
on join so a late joiner is told the current state. **This validates our E19 design line
for line** — never in the log, heartbeat + TTL, hello on join — and adds one thing we
should take: the `(sessionId, count)` loop-breaker, which is what makes gossiping
ephemerals across a mesh safe.

## 8 · Share policy — the closest thing to permissions

```ts
shareConfig: {
  announce: async (peerId, documentId?) => boolean,   // do I tell this peer the doc exists?
  access:   async (peerId, documentId?) => boolean,   // do I give it to them if asked?
}
```

Two predicates, evaluated per peer per document, concurrency-capped by a semaphore because
a many-peer server would fan out thousands of callbacks. A denied request is answered with
`doc-unavailable` — the same message as "nobody has it".

What it is: **per-document visibility**, decided by a callback on the serving peer. What it
is not: row-level, cryptographic, or evaluable offline by a third peer — it protects a
server's documents from unauthorised clients, not a mesh from a hacked client. Our grants
+ policy AST do the second thing, which is the harder one. But the *shape* — "announce"
separate from "access", and a server mode that never announces — is a useful vocabulary
for E24's `verifyJoin` and for the relay's room posture.

## 9 · The `DocumentSource` abstraction

Storage and network are both *sources* a document can come from, each with a priority.
The storage source has higher priority, so the network source **waits for storage to
finish loading before telling anyone the document is unavailable**. `DocHandle` is a small
state machine — `idle → loading → requesting → ready | unavailable | deleted` — with
`whenReady(states)`.

We do not have documents, we have one log per scope, so "unavailable" is not a state we
have. But the priority idea maps onto join (E14): *check local storage, then the relay,
then radios*, and do not declare "nothing to catch up" until the higher-priority source has
answered.

## 10 · Sync state persisted per storage id

`SyncStateTracker` persists, per document per remote `storageId`, the last known heads —
throttled, into storage under `[docId, "sync-state", storageId]`. On reconnect the repo
knows what that peer had and skips the Bloom exchange. Our equivalent is the relay's
per-author cursors and the client's own cursors; we do not persist *what each peer has*.
For a mesh with radios that come and go this is worth having: "the phone I met yesterday
had everything up to seq 400" saves a round trip on every re-meeting.

---

## What to take, by decision

| Decision | Take from automerge-repo |
|---|---|
| **D01 / E00** | the adapter acceptance-test suites — ship `runTransportTests()` and `runDriverTests()` |
| **D05** | six-method KV port under the SQLite store? (cost: range queries); size-based compaction (`incremental >= snapshot`); `SavedHeads`-style sequence guard once saves are async |
| **D09** | `flush()` with a concurrency cap tied to the storage's resource; `shutdown()` = flush then close |
| **D12** | `whenReady()` as a promise + a force-ready timeout; peer-candidate / peer-disconnected events if one adapter can reach many peers; **do not** copy drop-on-not-open |
| **D14** | `join { supportedProtocolVersions }` → `peer { selectedProtocolVersion }` \| `error` — verbatim |
| **D16** | `(sessionId, count)` loop-breaker for gossiped ephemerals; heartbeat + TTL + hello |
| **D17** | every subsystem emits metrics with sizes and durations, re-emitted by the top object |
| **E02 / E12** | an explicit per-peer `in_flight` flag; the per-peer sync step as a pure `(state, msg) → (state, msg?)` pair |
| **E14** | source priority: storage answers before the network may say "unavailable" |
| **E21 / E12** | persist "what each peer had" keyed by the thing that persists (storage / device), not the connection |

What *not* to take: Bloom-filter sync (we have exact cursors), per-document `DocHandle`s
(we have one log per scope), share policy as *the* permission model (ours must hold on a
peer the server never sees), and silent drop on a closed socket.
