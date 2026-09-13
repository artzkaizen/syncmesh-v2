import type { EngineOptions } from "@syncmesh/engine";
import type { TransportContext } from "@syncmesh/transport";

import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import {
  createHlcClock,
  parsePartitionKey,
  readRow,
  type CellValue,
  type ColumnName,
  type PartitionKey,
  type Procedure,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import {
  createGrantRegistry,
  createIdentity,
  decodeAndVerify,
  issueGrant,
  signEvent,
  type Identity,
} from "@syncmesh/wire";

import type { RelayFrame } from "../frames.js";
import type { RelayRoom, RelayRoomOptions } from "../room.js";
import type { RelaySocket, SendOutcome } from "../sender.js";
import type { RelayDial } from "../transport.js";

import { decodeRelayFrame } from "../frames.js";
import { openRelayRoom } from "../room.js";

export const schema = defineSchema({
  partitions: { org: {} },
  roles: { org: ["member"] },
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), body: t.text() },
      partition: "org",
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

export const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
export const ACME = parsePartitionKey("org:acme").unwrap();
export const GLOBEX = parsePartitionKey("org:globex").unwrap();
export const ISSUER = createIdentity(seed(1)).unwrap();

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const NOTES = "notes" as TableName;
const ID = "id" as ColumnName;
const BODY = "body" as ColumnName;
const CREATE = "notes.create" as Procedure;
const key = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** Overrides for a re-mint: a later `now` is what makes one grant supersede another. */
interface MintOptions {
  readonly now?: Temporal.Instant;
  readonly partitions?: readonly PartitionKey[];
}

export const mintFor = (
  device: Identity,
  account: string,
  { now = T0, partitions = [ACME, GLOBEX] }: MintOptions = {},
) =>
  issueGrant(ISSUER, {
    account,
    device: device.peerId,
    role: "member",
    partitions,
    validFor: Temporal.Duration.from({ days: 1 }),
    now,
  });

/** One granted peer: engine with a real validator, registry seeded with its own grant. */
export const peer = (n: number, account: string, startMs = 100) => {
  const identity = createIdentity(seed(n)).unwrap();
  const grants = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
  grants.register(mintFor(identity, account)).unwrap();
  let ms = startMs;
  const clock = createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms++) });
  const options: EngineOptions = {
    peerId: identity.peerId,
    clock,
    store: createMemoryEventStore(),
    validate: createValidator({ schema, grantFor: (p) => grants.grantFor(p) }),
  };
  const engine = createEngine(options);
  const context: TransportContext = { engine, identity, grants, now: () => T0 };
  return { identity, grants, engine, context };
};

export type Peer = ReturnType<typeof peer>;

/** One write on a peer, and the signed wire a relay would carry for it. */
export const write = async (
  p: Peer,
  id: string,
  body: string,
  partition = ACME,
): Promise<Uint8Array> => {
  const event = (
    await p.engine.mutate(
      CREATE,
      (tx) =>
        tx.insert(
          NOTES,
          key(id),
          new Map([
            [ID, id],
            [BODY, body],
          ]),
        ),
      { partition },
    )
  ).unwrap();
  return signEvent(event, p.identity).wire;
};

export const bodyOf = (p: Peer, id: string): CellValue | undefined =>
  readRow(p.engine.state(), NOTES, key(id))?.get(BODY);

/** The relay-side stored entry for a signed wire. */
export const entryOf = (wire: Uint8Array) => decodeAndVerify(wire).unwrap();

export const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the condition holds or the deadline passes; answers whether it ever did. */
export const until = async (check: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await tick(15);
  }
  return check();
};

/** A socket the test scripts: outcomes on demand, everything sent kept for inspection. */
export const fakeSocket = () => {
  const sent: Uint8Array[] = [];
  const closedWith: string[] = [];
  let mode: SendOutcome = "sent";
  const socket: RelaySocket = {
    send: (frame) => {
      if (mode === "sent") sent.push(frame);
      return mode;
    },
    close: (reason) => void closedWith.push(reason ?? ""),
  };
  const frames = (): readonly RelayFrame[] => sent.map((f) => decodeRelayFrame(f).unwrap());
  return {
    socket,
    sent,
    closedWith,
    setMode: (next: SendOutcome) => void (mode = next),
    frames,
    ofKind: <K extends RelayFrame["kind"]>(kind: K) =>
      frames().filter((f): f is Extract<RelayFrame, { kind: K }> => f.kind === kind),
    /** How many events reached this socket, however they were packaged. */
    events: () =>
      frames().reduce(
        (n, f) => n + (f.kind === "page" ? f.events.length : f.kind === "relayed" ? 1 : 0),
        0,
      ),
  };
};

/** A room on a fresh memory log; every option a test cares about is an override. */
export const openRoom = async (overrides: Partial<RelayRoomOptions> = {}) =>
  (
    await openRelayRoom({
      name: "main",
      store: createMemoryEventStore(),
      epoch: "epoch-1",
      keepaliveMs: 60_000,
      pageSize: 2,
      maxBacklog: 8,
      ...overrides,
    })
  ).unwrap();

/**
 * An in-process dial onto a live room: frames both ways, async delivery, a closable end.
 *
 * Declared here rather than in each test that wants one, because every property a
 * `relayTransport` has is a property of it talking to a real room — three copies of this helper is
 * three chances for one of them to deliver frames synchronously and prove something the wire does
 * not do.
 */
export const dialTo = (room: RelayRoom) => {
  let dials = 0;
  const dial = (): RelayDial => {
    dials += 1;
    const frames = new Set<(frame: Uint8Array) => void>();
    const closes = new Set<() => void>();
    let open = true;
    const hangUp = (): void => {
      if (!open) return;
      open = false;
      conn.closed();
      // the close event lands after any frames already in flight, as on a real socket
      queueMicrotask(() => {
        for (const cb of closes) cb();
      });
    };
    const socket: RelaySocket = {
      send: (frame) => {
        if (!open) return "dropped";
        // a frame accepted before close still delivers: TCP flushes what send() took
        const bytes = Uint8Array.from(frame);
        queueMicrotask(() => {
          for (const cb of frames) cb(bytes);
        });
        return "sent";
      },
      close: () => hangUp(),
    };
    const conn = room.connect(socket);
    return {
      send: (frame) => {
        if (!open) throw new Error("relay socket is not open");
        conn.receive(Uint8Array.from(frame));
      },
      onFrame: (cb) => {
        frames.add(cb);
        return () => void frames.delete(cb);
      },
      onClose: (cb) => {
        closes.add(cb);
        return () => void closes.delete(cb);
      },
      close: () => hangUp(),
    };
  };
  return { dial, dials: () => dials };
};

export { seed };
