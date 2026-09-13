import type { SyncEvent } from "@syncmesh/kernel";

import { seed } from "@syncmesh/kernel/test-fixtures";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import {
  linkTransport,
  loopbackPair,
  type LoopbackControl,
  type Transport,
} from "@syncmesh/transport";
import { createIdentity, issueGrant, type Identity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  syncSchema({
    partitions: { board: {} },
    roles: { board: ["member"] },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: "board",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
    presence: {
      cursor: {
        partition: "board",
        of: { x: t.float(), y: t.float(), label: t.text().nullable() },
        ttlMs: 300,
      },
      typing: { partition: "board", of: { noteId: t.text() }, ttlMs: 300 },
    },
  });

const ISSUER = createIdentity(seed(1)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const BOARD = "board:b1";

/** A clock the test moves, so TTL expiry is a fact rather than a wait. */
const clock = () => {
  let ms = T0.epochMilliseconds;
  return {
    now: () => Temporal.Instant.fromEpochMilliseconds(ms),
    advance: (by: number) => void (ms += by),
  };
};

const settle = async (control: LoopbackControl) => {
  for (let round = 0; round < 4; round += 1) {
    await control.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const open = async (
  identity: Identity,
  now: () => Temporal.Instant,
  transports: readonly Transport[],
) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity,
      issuer: ISSUER.peerId,
      now,
      transports,
    })
  ).unwrap();

const accountFor = (identity: Identity) => `acct_${String(identity.peerId).slice(0, 4)}`;

const grantTo = (mesh: Awaited<ReturnType<typeof open>>, identity: Identity) =>
  mesh.grants
    .register(
      issueGrant(ISSUER, {
        account: accountFor(identity),
        device: identity.peerId,
        role: "member",
        // SAFETY: test fixture instance in the documented kind:id form
        partitions: [BOARD] as never,
        validFor: Temporal.Duration.from({ days: 1 }),
        now: T0,
      }),
    )
    .unwrap();

/**
 * Two meshes on one loopback radio, each with a clock the test drives. Grants are registered
 * only once both ends exist: a bare loopback has no catch-up, so a frame sent before the other
 * side is listening is simply gone — which is what `resync` and a relay's `hello` repair.
 */
const room = async () => {
  const a = createIdentity(seed(40)).unwrap();
  const b = createIdentity(seed(80)).unwrap();
  const { a: linkA, b: linkB, control } = loopbackPair();
  const clockA = clock();
  const clockB = clock();
  const meshA = await open(a, clockA.now, [linkTransport("loopback:a", () => linkA)]);
  const meshB = await open(b, clockB.now, [linkTransport("loopback:b", () => linkB)]);
  await Promise.all([meshA.ready(), meshB.ready()]);
  grantTo(meshA, a);
  grantTo(meshB, b);
  await settle(control);
  return { a, b, meshA, meshB, clockA, clockB, control };
};

describe("presence — the ephemeral tier", () => {
  test("a value reaches the other device with its account, and never the log", async () => {
    const { a, meshA, meshB, control } = await room();
    const events: SyncEvent[] = [];
    meshA.engine.onOutbound((e) => void events.push(e));

    meshA.presence(BOARD).cursor.set({ x: 12.5, y: 4, label: null });
    await settle(control);

    const seen = meshB.presence(BOARD).cursor.peers();
    expect(seen).toHaveLength(1);
    expect(String(seen[0]?.peerId)).toBe(String(a.peerId));
    expect(seen[0]?.account).toBe(accountFor(a));
    expect(seen[0]?.value).toEqual({ x: 12.5, y: 4, label: null });

    // the tier's whole point: nothing above reached the durable side
    expect(events).toHaveLength(0);
    expect((await meshA.engine.eventsSince(new Map())).unwrap()).toHaveLength(0);
    expect(meshA.engine.state().size).toBe(0);
    await meshA.stop();
    await meshB.stop();
  });

  test("conflation: the last value wins, and topics and instances stay separate", async () => {
    const { meshA, meshB, control } = await room();
    const at = meshA.presence(BOARD);
    for (let i = 1; i <= 20; i += 1) at.cursor.set({ x: i, y: 0, label: null });
    at.typing.set({ noteId: "n1" });
    await settle(control);

    const cursors = meshB.presence(BOARD).cursor.peers();
    expect(cursors).toHaveLength(1); // twenty sets, one peer, one value
    expect(cursors[0]?.value).toEqual({ x: 20, y: 0, label: null });
    expect(meshB.presence(BOARD).typing.peers()[0]?.value).toEqual({ noteId: "n1" });
    expect(meshB.presence("board:b2").cursor.peers()).toEqual([]); // another instance is another room
    await meshA.stop();
    await meshB.stop();
  });

  test("clear removes it now; a stale value expires on its own", async () => {
    const { meshA, meshB, clockB, control } = await room();
    meshA.presence(BOARD).cursor.set({ x: 1, y: 1, label: "me" });
    await settle(control);
    expect(meshB.presence(BOARD).cursor.peers()).toHaveLength(1);

    meshA.presence(BOARD).cursor.clear();
    await settle(control);
    expect(meshB.presence(BOARD).cursor.peers()).toEqual([]);

    // a value nobody refreshes goes stale wherever it is held — no message required
    meshA.presence(BOARD).typing.set({ noteId: "n1" });
    await settle(control);
    expect(meshB.presence(BOARD).typing.peers()).toHaveLength(1);
    clockB.advance(400); // past the topic's 300 ms ttl
    expect(meshB.presence(BOARD).typing.peers()).toEqual([]);
    await meshA.stop();
    await meshB.stop();
  });

  test("stop() is a departure: the peer is gone before the socket is", async () => {
    const { meshA, meshB, control } = await room();
    meshA.presence(BOARD).cursor.set({ x: 3, y: 3, label: null });
    await settle(control);
    expect(meshB.presence(BOARD).cursor.peers()).toHaveLength(1);
    await meshA.stop();
    await settle(control);
    expect(meshB.presence(BOARD).cursor.peers()).toEqual([]);
    await meshB.stop();
  });

  test("subscribe fires for the topic that changed, and a value failing its shape is a definition mistake", async () => {
    const { meshA, meshB, control } = await room();
    let cursors = 0;
    let typings = 0;
    const at = meshB.presence(BOARD);
    at.cursor.subscribe(() => void (cursors += 1));
    at.typing.subscribe(() => void (typings += 1));

    meshA.presence(BOARD).cursor.set({ x: 1, y: 1, label: null });
    await settle(control);
    expect([cursors, typings]).toEqual([1, 0]);

    /* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- deliberately wrong values under test */
    expect(() => meshA.presence(BOARD).cursor.set({ x: "over there", y: 1 } as never)).toThrow(
      "presence cursor.x",
    );
    expect(() => meshA.presence(BOARD).cursor.set({ x: 1, y: 1, nope: 2 } as never)).toThrow(
      'no column "nope"',
    );
    /* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
    expect(() => meshA.presence("not a key")).toThrow("kind:id");
    await meshA.stop();
    await meshB.stop();
  });
});
