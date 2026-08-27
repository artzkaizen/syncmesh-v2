/**
 * The map's content, curated by hand — the code never generates it, so it
 * drifts only if we let it. Districts are the architecture (not the directory
 * tree), buildings are modules with their real files (the server counts the
 * lines), flows are the stories a reader should be able to watch.
 *
 * The prose twin is plan/codebase-map.md; every step's file link must point at
 * a file that exists — explorer.ts refuses to start otherwise (rule 4:
 * definition mistakes throw).
 */

export type Building = {
  code: string;
  name: string;
  files: readonly string[];
  /** Planned, not built — drawn dashed. */
  ghost?: true;
  /** An actor outside the repo — fixed height, no files. */
  virtual?: true;
};

export type District = {
  id: string;
  name: string;
  gx: number;
  gy: number;
  cols: number;
  buildings: readonly Building[];
};

export type Step = {
  /** Building code the step lands on. */
  b: string;
  t: string;
  /** Repo-relative file the claim anchors to. */
  f?: string;
};

export type Flow = {
  slug: string;
  name: string;
  payload: string;
  summary: string;
  readMore: string;
  steps: readonly Step[];
};

export const DISTRICTS: readonly District[] = [
  {
    id: "outside",
    name: "OUTSIDE WORLD",
    gx: 30,
    gy: 0,
    cols: 2,
    buildings: [
      { code: "X1", name: "YOUR APP", files: [], virtual: true },
      { code: "X2", name: "ANOTHER DEVICE", files: [], virtual: true },
      { code: "X3", name: "YOUR AUTH SERVER", files: [], virtual: true },
      { code: "X4", name: "RELAY · E12", files: [], virtual: true, ghost: true },
    ],
  },
  {
    id: "client",
    name: "CLIENT — THE MESH",
    gx: 12,
    gy: 2,
    cols: 3,
    buildings: [
      {
        code: "ME",
        name: "mesh",
        files: ["packages/client/src/mesh.ts", "packages/client/src/transports.ts"],
      },
      {
        code: "BO",
        name: "boot",
        files: ["packages/client/src/boot.ts", "packages/client/src/errors.ts"],
      },
      { code: "HI", name: "history", files: ["packages/client/src/history.ts"] },
      { code: "DL", name: "delivered", files: ["packages/client/src/delivered.ts"] },
      { code: "GR", name: "grants", files: ["packages/client/src/grants.ts"] },
    ],
  },
  {
    id: "server",
    name: "SQL SURFACE",
    gx: 36,
    gy: 9,
    cols: 1,
    buildings: [
      {
        code: "DZ",
        name: "drizzle handle",
        files: [
          "packages/drizzle/src/index.ts",
          "packages/drizzle/src/face.ts",
          "packages/drizzle/src/proxy.ts",
          "packages/drizzle/src/read.ts",
          "packages/drizzle/src/live.ts",
          "packages/drizzle/src/sqlite.ts",
          "packages/drizzle/src/postgres.ts",
        ],
      },
      { code: "RP", name: "oRPC", files: ["packages/orpc/src/index.ts"] },
    ],
  },
  {
    id: "engine",
    name: "ENGINE",
    gx: 16,
    gy: 12,
    cols: 3,
    buildings: [
      {
        code: "EN",
        name: "engine & fold",
        files: [
          "packages/engine/src/engine.ts",
          "packages/engine/src/writes.ts",
          "packages/engine/src/listeners.ts",
          "packages/engine/src/telemetry.ts",
        ],
      },
      {
        code: "VA",
        name: "validator",
        files: [
          "packages/engine/src/validate.ts",
          "packages/engine/src/can.ts",
          "packages/engine/src/errors.ts",
        ],
      },
      { code: "AD", name: "admit", files: ["packages/engine/src/admit.ts"] },
      {
        code: "SY",
        name: "sync",
        files: ["packages/engine/src/sync.ts", "packages/engine/src/coverage.ts"],
      },
      { code: "LK", name: "link", files: ["packages/engine/src/link.ts"] },
      { code: "CP", name: "compaction", files: ["packages/engine/src/compaction.ts"] },
      {
        code: "UN",
        name: "undo",
        files: [
          "packages/engine/src/undo.ts",
          "packages/engine/src/tx.ts",
          "packages/engine/src/build-event.ts",
        ],
      },
      { code: "EB", name: "boot", files: ["packages/engine/src/boot.ts"] },
      {
        code: "ES",
        name: "store ports",
        files: ["packages/engine/src/store.ts", "packages/engine/src/state-store.ts"],
      },
    ],
  },
  {
    id: "kernel",
    name: "KERNEL",
    gx: 3,
    gy: 15,
    cols: 2,
    buildings: [
      {
        code: "HL",
        name: "hlc & stamps",
        files: [
          "packages/kernel/src/hlc.ts",
          "packages/kernel/src/stamp.ts",
          "packages/kernel/src/peer-id.ts",
        ],
      },
      {
        code: "MG",
        name: "merge",
        files: [
          "packages/kernel/src/apply.ts",
          "packages/kernel/src/strategy.ts",
          "packages/kernel/src/record.ts",
        ],
      },
      { code: "KS", name: "state", files: ["packages/kernel/src/state.ts"] },
      {
        code: "EV",
        name: "events",
        files: [
          "packages/kernel/src/event.ts",
          "packages/kernel/src/change.ts",
          "packages/kernel/src/partition.ts",
          "packages/kernel/src/primitives.ts",
        ],
      },
    ],
  },
  {
    id: "schema",
    name: "SCHEMA & POLICY",
    gx: 1,
    gy: 25,
    cols: 2,
    buildings: [
      {
        code: "MF",
        name: "manifest",
        files: [
          "packages/schema/src/manifest.ts",
          "packages/schema/src/reserved.ts",
          "packages/schema/src/from-drizzle.ts",
        ],
      },
      {
        code: "TB",
        name: "tables",
        files: [
          "packages/schema/src/table.ts",
          "packages/schema/src/column.ts",
          "packages/schema/src/check.ts",
          "packages/schema/src/names.ts",
          "packages/schema/src/convert.ts",
          "packages/schema/src/standard-schema.ts",
        ],
      },
      { code: "BN", name: "combinators", files: ["packages/schema/src/bind.ts"] },
      {
        code: "PY",
        name: "policy ast",
        files: [
          "packages/policy/src/ast.ts",
          "packages/policy/src/evaluate.ts",
          "packages/policy/src/doc.ts",
        ],
      },
    ],
  },
  {
    id: "wire",
    name: "WIRE",
    gx: 29,
    gy: 18,
    cols: 2,
    buildings: [
      {
        code: "CB",
        name: "canonical cbor",
        files: [
          "packages/wire/src/cbor.ts",
          "packages/wire/src/cbor-decode.ts",
          "packages/wire/src/cbor-guards.ts",
          "packages/wire/src/hex.ts",
        ],
      },
      {
        code: "EE",
        name: "envelope",
        files: [
          "packages/wire/src/envelope.ts",
          "packages/wire/src/event-codec.ts",
          "packages/wire/src/row-codec.ts",
        ],
      },
      { code: "ID", name: "identity", files: ["packages/wire/src/identity.ts"] },
      {
        code: "GG",
        name: "grants on the wire",
        files: ["packages/wire/src/grant.ts", "packages/wire/src/grant-registry.ts"],
      },
    ],
  },
  {
    id: "storage",
    name: "STORAGE",
    gx: 13,
    gy: 25,
    cols: 3,
    buildings: [
      { code: "WR", name: "writer", files: ["packages/storage/src/writer.ts"] },
      {
        code: "CA",
        name: "change capture",
        files: ["packages/storage/src/capture.ts", "packages/storage/src/identifiers.ts"],
      },
      { code: "PJ", name: "projection", files: ["packages/storage/src/projection.ts"] },
      { code: "RF", name: "read filter", files: ["packages/storage/src/read-filter.ts"] },
      { code: "RL", name: "row-level security", files: ["packages/storage/src/rls.ts"] },
      {
        code: "SE",
        name: "event log",
        files: ["packages/storage/src/event-store.ts", "packages/storage/src/driver.ts"],
      },
      {
        code: "SL",
        name: "state cache",
        files: [
          "packages/storage/src/state-store.ts",
          "packages/storage/src/record-codec.ts",
        ],
      },
      {
        code: "DI",
        name: "dialects",
        files: [
          "packages/storage/src/dialect.ts",
          "packages/storage/src/dialect-sqlite.ts",
          "packages/storage/src/dialect-postgres.ts",
          "packages/storage/src/sql.ts",
        ],
      },
      { code: "MI", name: "open stores", files: ["packages/storage/src/open-stores.ts"] },
    ],
  },
  {
    id: "transport",
    name: "TRANSPORT",
    gx: 35,
    gy: 26,
    cols: 2,
    buildings: [
      { code: "TP", name: "the port", files: ["packages/transport/src/transport.ts"] },
      {
        code: "BR",
        name: "bridge",
        files: ["packages/transport/src/bridge.ts", "packages/transport/src/holdback.ts"],
      },
      { code: "FR", name: "frames", files: ["packages/transport/src/frame.ts"] },
      { code: "LL", name: "loopback", files: ["packages/transport/src/link.ts"] },
    ],
  },
  {
    id: "proofs",
    name: "ADAPTERS & PROOFS",
    gx: 22,
    gy: 39,
    cols: 3,
    buildings: [
      { code: "AB", name: "sqlite-bun", files: ["adapters/sqlite-bun/src/index.ts"] },
      { code: "AN", name: "sqlite-node", files: ["adapters/sqlite-node/src/index.ts"] },
      { code: "PG", name: "postgres", files: ["adapters/postgres/src/index.ts"] },
      {
        code: "CF",
        name: "conformance",
        files: ["conformance/src/harness.ts", "conformance/src/vectors.ts"],
      },
      { code: "DT", name: "driver suite", files: ["packages/storage/src/driver-tests/index.ts"] },
      {
        code: "TT",
        name: "transport suite",
        files: ["packages/transport/src/transport-tests/index.ts"],
      },
    ],
  },
];

/** District-level dependencies, drawn faint — the map's structure when idle. */
export const DEPS: readonly (readonly [string, string])[] = [
  ["client", "engine"],
  ["client", "storage"],
  ["client", "server"],
  ["server", "storage"],
  ["engine", "kernel"],
  ["engine", "schema"],
  ["storage", "engine"],
  ["storage", "wire"],
  ["transport", "engine"],
  ["transport", "wire"],
  ["wire", "kernel"],
  ["proofs", "storage"],
  ["proofs", "transport"],
];

export const FLOWS: readonly Flow[] = [
  {
    slug: "write",
    name: "A write becomes an event",
    payload: "UPDATE jobs SET … → one signed event",
    summary:
      "D20, the write path: the app writes its own tables with its own SQL; triggers capture the transaction, the verdict runs before COMMIT, and the net effect replays as one signed, stamped, numbered event — the log is the outbox.",
    readMore: "plan/decisions/D20.md",
    steps: [
      {
        b: "X1",
        t: "The app writes its own tables with its own SQL — Drizzle on the mesh's connection, through the handle mesh.on(\"org:acme\") hands out.",
        f: "packages/client/src/mesh.ts",
      },
      {
        b: "DZ",
        t: "db.transaction() is the capture boundary — begin opens a capture, commit settles it; a lone write statement is its own transaction, hence its own event. A read-only transaction is simply not an event.",
        f: "packages/drizzle/src/proxy.ts",
      },
      {
        b: "WR",
        t: "The writer wraps the transaction in captureChanges and labels the event from what it turned out to do; a transaction touching only local tables is stamped local — it never leaves this device.",
        f: "packages/storage/src/writer.ts",
      },
      {
        b: "CA",
        t: "Triggers log every row's before and after into _syncmesh_changes — then the log folds to one change per row, its net effect. One event has one stamp.",
        f: "packages/storage/src/capture.ts",
      },
      {
        b: "VA",
        t: "The ladder runs inside the transaction, before COMMIT — grant, partition, schema, policy, and the acting principal's rules. A refused write rolls back and never reaches the table.",
        f: "packages/engine/src/validate.ts",
      },
      {
        b: "CA",
        t: "The write's partition is stamped onto inserted rows with the guard at rest — the app's INSERT never names a tenant.",
        f: "packages/storage/src/capture.ts",
      },
      {
        b: "EN",
        t: "The captured changes replay into engine.mutate: the HLC ticks once, lastSeq is re-read (a sibling tab may have allocated), and one signed event exists.",
        f: "packages/engine/src/engine.ts",
      },
      {
        b: "SE",
        t: "Append. The log is the outbox: a write is real once appended — and where the store offers atomic, the log and the folded state commit in one transaction, so they cannot disagree.",
        f: "packages/storage/src/event-store.ts",
      },
      {
        b: "MG",
        t: "The fold: applyChange joins each change into state — commutative, associative, idempotent, so arrival order can never matter.",
        f: "packages/kernel/src/apply.ts",
      },
      {
        b: "PJ",
        t: "The fold writes the app's tables back, so SQL reads see synced state. Two writers, one order: capture and fold take turns on the connection.",
        f: "packages/storage/src/projection.ts",
      },
      {
        b: "EN",
        t: "onOutbound hands the signed event to every transport. Delivery is delivered()'s question, not the write's.",
        f: "packages/engine/src/engine.ts",
      },
    ],
  },
  {
    slug: "converge",
    name: "Two peers converge",
    payload: "cursors ⇄ events",
    summary:
      "Anti-entropy: cursors first, then exactly what the other side lacks. Signatures verify on received bytes, gaps are never jumped, and the same fold runs on both ends.",
    readMore: "plan/codebase-map.md",
    steps: [
      {
        b: "X2",
        t: "Another device holds events this one lacks — offline edits on both sides, different fields of the same row.",
      },
      {
        b: "SY",
        t: "Cursors first: generateSyncMessage is pure — no I/O, no clock. inFlight blocks a second batch until any reply clears it.",
        f: "packages/engine/src/sync.ts",
      },
      {
        b: "FR",
        t: "Frames on the wire: grant 0, cursors 2, event 3 — integers doubling as the traffic class. An unknown tag is ignored, never an error.",
        f: "packages/transport/src/frame.ts",
      },
      {
        b: "BR",
        t: "The bridge: grants first, then cursors, then events. Out-of-order events are held per author — a gap is never jumped; overflow forces a resync.",
        f: "packages/transport/src/bridge.ts",
      },
      {
        b: "EE",
        t: "decodeAndVerify: Ed25519 over the exact received core bytes. A relayed event keeps its author's signature — nobody else can sign it.",
        f: "packages/wire/src/envelope.ts",
      },
      {
        b: "AD",
        t: "Admit: own events skipped, duplicates dropped by id, and a failing event is quarantined with its reason — never stored, never folded.",
        f: "packages/engine/src/admit.ts",
      },
      {
        b: "HL",
        t: "clock.receive ratchets: a remote stamp can only push this clock forward, drift clamped — no write is ever stamped in the past.",
        f: "packages/kernel/src/hlc.ts",
      },
      {
        b: "MG",
        t: "The same fold as a local write. Both rows merge on both sides — whichever link delivered first.",
        f: "packages/kernel/src/apply.ts",
      },
      {
        b: "DL",
        t: "The cursor exchange records what the peer now holds; delivered({ event }) resolves. Delivery, not approval — every receiver ran the same policy itself.",
        f: "packages/client/src/delivered.ts",
      },
    ],
  },
  {
    slug: "boot",
    name: "Boot: open, don't refold",
    payload: "createMesh(…) → 79ms, not 469ms",
    summary:
      "Durable by default: the platform's SQLite opens, tables and capture install, the state cache loads, only the log's tail replays, and the clock passes every stored stamp before a single write is numbered.",
    readMore: "bench/README.md",
    steps: [
      {
        b: "X1",
        t: "createMesh({ schema, identity }) — durable by default; memory is never a default, you ask for it. Or hand it your own driver and the connection stays yours.",
        f: "packages/client/src/mesh.ts",
      },
      {
        b: "BO",
        t: "openMeshEngine: no store passed → the platform's own SQLite, one file per identity under dataDir.",
        f: "packages/client/src/boot.ts",
      },
      {
        b: "AB",
        t: "bun:sqlite or node:sqlite on a device — or your Postgres pool on an authority — behind the same driver port. The driver never authors SQL of its own; the dialect carries the statements.",
        f: "adapters/sqlite-bun/src/index.ts",
      },
      {
        b: "MI",
        t: "openStores: the dialect's migrations run (PRAGMA user_version on a device, _syncmesh_ tables in Postgres), the app's tables are created, capture and the projection installed — one database holds the log, the state and your tables.",
        f: "packages/storage/src/open-stores.ts",
      },
      {
        b: "EB",
        t: "The cache first: loadAll + loadCursors. A corrupt cache over a compacted log refuses to open — rejoin from a peer; over a full log it clears and refolds.",
        f: "packages/engine/src/boot.ts",
      },
      {
        b: "ES",
        t: "Replay only the tail: allSince(coverage), both scopes. Boot is O(live rows), not O(events) — 79ms vs 469ms at 20k events in bench.",
        f: "packages/engine/src/store.ts",
      },
      {
        b: "HL",
        t: "Clock catch-up: maxHlc is received before the engine exists — a new write is never numbered or stamped behind the log.",
        f: "packages/engine/src/boot.ts",
      },
      {
        b: "EN",
        t: "createEngine over the folded state; the mesh hands out Drizzle handles above it, one per (instance, principal).",
        f: "packages/engine/src/engine.ts",
      },
      {
        b: "TP",
        t: "Transports start at construction; whenReady force-resolves after a timeout — a dead network never wedges the mesh.",
        f: "packages/transport/src/transport.ts",
      },
    ],
  },
  {
    slug: "grant",
    name: "A grant is bytes",
    payload: "grant-request → [core, sig]",
    summary:
      "Onboarding with no internet on the new device: ~100 signed bytes any peer can carry. The courier can delay or drop — never forge, alter or redirect.",
    readMore: "plan/flows/grant-onboarding.md",
    steps: [
      {
        b: "X2",
        t: "A new device mints its identity offline — the peerId is the Ed25519 public key, hex. No account exists yet.",
        f: "packages/wire/src/identity.ts",
      },
      {
        b: "FR",
        t: "It asks to exist: a grant-request frame on any link it has. Untrusted by definition.",
        f: "packages/transport/src/frame.ts",
      },
      {
        b: "BR",
        t: "Any granted peer carries the request onward. The signature makes forging, altering and redirecting impossible — delay and drop are the courier's only powers.",
        f: "packages/transport/src/bridge.ts",
      },
      {
        b: "X3",
        t: "Your server mints: issueGrant binds account + device key + role + partitions + expiry into ~100 signed bytes, inside the login you already run.",
        f: "packages/wire/src/grant.ts",
      },
      {
        b: "GG",
        t: "The signed grant rides back verbatim and registers: newest issuedAt wins, expiry is filtered at read time. Revocation propagation is E21.",
        f: "packages/wire/src/grant-registry.ts",
      },
      {
        b: "AD",
        t: "Meanwhile the newcomer's events were quarantined on NoGrant — never stored. Quarantine is not an error; it is an ordering.",
        f: "packages/engine/src/admit.ts",
      },
      {
        b: "BR",
        t: "Grants travel ahead of events on every session; a resync's cursor catch-up re-requests what quarantine dropped, and the mesh converges.",
        f: "packages/transport/src/bridge.ts",
      },
    ],
  },
  {
    slug: "live",
    name: "A live query re-runs",
    payload: "live(db.select()…) → fresh rows",
    summary:
      "A Drizzle query, kept warm: the handle walks the query's SQL for the tables it touches, and a fold on any of them re-runs it — subscribers hear only when the rows actually changed.",
    readMore: "plan/codebase-map.md",
    steps: [
      {
        b: "X1",
        t: "The UI holds a query: handle.live(db.select().from(jobs).where(…)) — any Drizzle query, joins included.",
        f: "packages/drizzle/src/index.ts",
      },
      {
        b: "DZ",
        t: "tablesOf walks the query's own SQL — through columns, subqueries and fragments — for every table it mentions.",
        f: "packages/drizzle/src/live.ts",
      },
      {
        b: "MG",
        t: "A fold touches rows — a local write or a remote batch, same path.",
        f: "packages/kernel/src/apply.ts",
      },
      {
        b: "EN",
        t: "The fold notifies after the state store commit — a listener that re-reads the SQL tables sees the rows, not the past.",
        f: "packages/engine/src/engine.ts",
      },
      {
        b: "DZ",
        t: "The query re-runs against the projected tables; the result is diffed, and subscribers hear only when the rows changed.",
        f: "packages/drizzle/src/live.ts",
      },
    ],
  },
  {
    slug: "undo",
    name: "Undo is a write",
    payload: "revert(eventId)",
    summary:
      "Revert computes the inverse and writes it forward as a compensating event in the original's partition — so every peer folds it like anything else, and redo is revert of revert.",
    readMore: "plan/codebase-map.md",
    steps: [
      {
        b: "X1",
        t: "mesh.revert(eventId) — one of this device's last undoDepth writes; anything older is CannotRevert, a value.",
        f: "packages/client/src/mesh.ts",
      },
      {
        b: "UN",
        t: "invert: restore exactly the touched columns (a column that did not exist reverts to null), delete created rows, re-insert deleted ones whole.",
        f: "packages/engine/src/undo.ts",
      },
      {
        b: "EN",
        t: "The compensating event is written in the original event's partition — undo is a forward write, never a rollback of the log.",
        f: "packages/engine/src/engine.ts",
      },
      {
        b: "MG",
        t: "Every peer folds it like any other event; revert a revert and you have redo.",
        f: "packages/kernel/src/apply.ts",
      },
    ],
  },
  {
    slug: "compact",
    name: "Compaction",
    payload: "acks → floor → events go",
    summary:
      "Events every counted peer has acked — and the state store has persisted — can go. Floors keep lastSeq and maxHlc honest; peers cannot observe that anything happened.",
    readMore: "research/rfcs/0015-retention.md",
    steps: [
      {
        b: "EN",
        t: "Every cursor exchange records an ack: what each peer is known to hold, and when it said so.",
        f: "packages/engine/src/engine.ts",
      },
      {
        b: "CP",
        t: "ackFloor: the minimum across live acks, per author — an author some ack has never heard of floors at zero, and a silent peer pins unless forgetPeersAfter says otherwise.",
        f: "packages/engine/src/compaction.ts",
      },
      {
        b: "CP",
        t: "clampToPersisted: never drop below what the state cache holds — a device cannot refold what it deleted.",
        f: "packages/engine/src/compaction.ts",
      },
      {
        b: "SE",
        t: "compactBelow: the events go, the floors stay — lastSeq and maxHlc never regress, and a peer at the floor still delta-syncs.",
        f: "packages/storage/src/event-store.ts",
      },
      {
        b: "CP",
        t: "No state store → refused outright. The log would be the only copy of state, and we do not delete the only copy.",
        f: "packages/engine/src/compaction.ts",
      },
    ],
  },
  {
    slug: "server",
    name: "The server acts as the caller",
    payload: "caller: { account, partition }",
    summary:
      "oRPC procedures get the Drizzle handle pinned to the caller's instance, acting as the caller — the schema is the only permission model, on the server exactly as on every device.",
    readMore: "plan/flows/roles-and-api.md",
    steps: [
      {
        b: "X3",
        t: "A request arrives with a session — your auth says who is calling; the mesh cannot know this on its own.",
        f: "packages/orpc/src/index.ts",
      },
      {
        b: "RP",
        t: "withMesh: caller in, handle out — mesh.on(caller.partition, { as: caller }). An unresolvable instance is BAD_REQUEST before any handler runs.",
        f: "packages/orpc/src/index.ts",
      },
      {
        b: "DZ",
        t: "read(table): a subquery with the caller's read rule — and the pin — compiled in; one handle per (instance, principal), cached.",
        f: "packages/drizzle/src/index.ts",
      },
      {
        b: "RF",
        t: "The rule compiles to a SQL WHERE under every source — unreadable rows are absent by construction, not filtered after the fact.",
        f: "packages/storage/src/read-filter.ts",
      },
      {
        b: "RL",
        t: "On an authority's Postgres the same rules install as row-level security: the caller rides in transaction-local settings, so a plain select is already the caller's view — no wrapper at the call site.",
        f: "packages/storage/src/rls.ts",
      },
      {
        b: "WR",
        t: "A write the caller's rules deny rejects the transaction before COMMIT — PolicyDenied, before any event exists.",
        f: "packages/storage/src/writer.ts",
      },
      {
        b: "RP",
        t: "The denial surfaces as FORBIDDEN; an allowed write is still the device's event, attributed to the caller in data.",
        f: "packages/orpc/src/index.ts",
      },
    ],
  },
];
