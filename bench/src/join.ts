import type { Snapshot, StoredEvent } from "@syncmesh/engine";
import type {
  CellValue,
  ColumnName,
  Logical,
  PartitionKey,
  Row,
  RowKey,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";
import type { Procedure } from "@syncmesh/kernel";

import { createEngine, createMemoryEventStore, snapshotOf } from "@syncmesh/engine";
import { createHlcClock, eventId, parsePartitionKey, parseSeqNum } from "@syncmesh/kernel";
import { panic } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { eventFrame, snapChunkFrame } from "@syncmesh/transport";
import { createIdentity, decodeAndVerify, encodeSnapshotRows, signEvent } from "@syncmesh/wire";

/**
 * What a join costs, four ways (RFC-0019). The bytes are wire bytes — the frames that actually
 * travel, an event frame per event or a `snap-chunk` per page — and the apply time is the
 * receiving engine's own work, verification included, because that is the half a slow radio does
 * not save you from.
 *
 * `bun run --cwd bench join [--events N]`
 */

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- bench fixtures; naming rules are not what is measured */
const NOTES = "notes" as TableName;
const PROCEDURE = "notes.write" as Procedure;
const key = (n: number) => `n${n}` as RowKey;
const column = (name: string) => name as ColumnName;
const ZERO = 0 as Logical;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const flag = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : Number(process.argv[at + 1]);
  return value === undefined || Number.isNaN(value) ? fallback : value;
};

const EVENTS = flag("events", 60_000);
const ROWS = flag("rows", 30_000);
const TEAMS = 8;
const MINE = 2;
const WINDOW = 2_000;
const PAGE = 500;

const author = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 40 + i)).unwrap();
const teams: readonly PartitionKey[] = Array.from({ length: TEAMS }, (_, i) =>
  parsePartitionKey(`org:team${i}`).unwrap(),
);
const mine = teams.slice(0, MINE);

const teamFor = (index: number): PartitionKey => {
  const team = teams[index % TEAMS];
  return team === undefined ? panic("the team list is fixed and never empty") : team;
};

const row = (seq: number): Row =>
  new Map<ColumnName, CellValue>([
    [column("title"), `note ${seq}`],
    [column("done"), seq % 2 === 0],
    [column("body"), "x".repeat(120)],
  ]);

/** Event `seq`: an insert while `seq ≤ rows`, then updates cycling over the same rows. */
const event = (seq: number): SyncEvent => {
  const seqNum = parseSeqNum(seq).unwrap();
  const index = ((seq - 1) % ROWS) + 1;
  const k = key(index);
  const change =
    seq <= ROWS
      ? { kind: "insert" as const, table: NOTES, key: k, row: row(seq) }
      : { kind: "update" as const, table: NOTES, key: k, patch: row(seq) };
  return {
    v: 1,
    id: eventId(author.peerId, seqNum),
    peerId: author.peerId,
    seqNum,
    hlc: [Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000 + seq), ZERO],
    procedure: PROCEDURE,
    changes: [change],
    partition: teamFor(index),
  };
};

const clock = () => createHlcClock({ now: () => Temporal.Now.instant() });
/** A device that is not the author, so the events it receives are somebody else's — as a join's are. */
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const fresh = () =>
  createEngine({ peerId: device.peerId, clock: clock(), store: createMemoryEventStore() });

const gzipped = (frames: readonly Uint8Array[]): number => {
  const joined = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const frame of frames) {
    joined.set(frame, at);
    at += frame.length;
  }
  return Bun.gzipSync(joined).length;
};

const raw = (frames: readonly Uint8Array[]): number => frames.reduce((n, f) => n + f.length, 0);

interface Measured {
  readonly strategy: string;
  readonly units: string;
  readonly raw: number;
  readonly gzip: number;
  readonly applyMs: number;
}

const timed = async (fn: () => Promise<void>): Promise<number> => {
  const from = Bun.nanoseconds();
  await fn();
  return (Bun.nanoseconds() - from) / 1e6;
};

/** Every event, signed and framed: what replaying the log actually puts on the wire. */
const replay = async (events: readonly SyncEvent[]): Promise<Measured> => {
  const wires = events.map((e) => signEvent(e, author).wire);
  const frames = wires.map(eventFrame);
  const receiver = fresh();
  const applyMs = await timed(async () => {
    // verification is the cost, and it is per event: this is the number the chain exists to kill
    const entries: StoredEvent[] = [];
    for (const wire of wires) entries.push(decodeAndVerify(wire).unwrap());
    (await receiver.receiveBatch(entries)).unwrap();
  });
  return {
    strategy: "replay the log",
    units: `${events.length.toLocaleString()} events`,
    raw: raw(frames),
    gzip: gzipped(frames),
    applyMs,
  };
};

/** A snapshot's rows, paged and framed exactly as the join exchange would send them. */
const ship = async (strategy: string, snapshot: Snapshot): Promise<Measured> => {
  const frames: Uint8Array[] = [];
  for (let i = 0; i < snapshot.rows.length; i += PAGE)
    frames.push(
      snapChunkFrame("bench", i / PAGE, encodeSnapshotRows(snapshot.rows.slice(i, i + PAGE))),
    );
  const receiver = fresh();
  const applyMs = await timed(async () => void (await receiver.installSnapshot(snapshot)));
  return {
    strategy,
    units: `${snapshot.rows.length.toLocaleString()} rows`,
    raw: raw(frames),
    gzip: gzipped(frames),
    applyMs,
  };
};

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;
const ms = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value.toFixed(0)} ms`;

const holder = fresh();
const events = Array.from({ length: EVENTS }, (_, i) => event(i + 1));
for (let from = 0; from < events.length; from += 5_000)
  (await holder.receiveBatch(events.slice(from, from + 5_000).map((e) => ({ event: e })))).unwrap();

const state = holder.state();
const coverage = holder.coverage();
const full = snapshotOf(state, coverage);
const scoped = snapshotOf(state, coverage, { interest: { partitions: mine } });
// a window is not yet a field of `Interest`; taking the newest rows here measures what one would
// cost, which is the point of the row — O(your screen) rather than O(the workspace)
const windowed: Snapshot = { ...scoped, rows: scoped.rows.slice(-WINDOW) };

const results = [
  await replay(events),
  await ship("full snapshot", full),
  await ship(`scoped (${MINE} of ${TEAMS} teams)`, scoped),
  await ship(`scoped + windowed (${WINDOW.toLocaleString()} newest)`, windowed),
];

const base = results[0];
console.log(
  `\njoin — ${EVENTS.toLocaleString()} events, ${ROWS.toLocaleString()} rows, ${TEAMS} teams\n`,
);
console.log("| join strategy | units | raw | gzipped | apply |");
console.log("|---|---|---|---|---|");
for (const r of results)
  console.log(`| ${r.strategy} | ${r.units} | ${mb(r.raw)} | ${mb(r.gzip)} | ${ms(r.applyMs)} |`);
if (base !== undefined) {
  console.log("\ngzipped reduction versus replay:");
  for (const r of results.slice(1))
    console.log(
      `  ${r.strategy}: ${(base.gzip / r.gzip).toFixed(1)}×, apply ${(base.applyMs / r.applyMs).toFixed(0)}× faster`,
    );
}
