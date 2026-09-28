import type { Interest } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

import { readRow } from "@syncmesh/kernel";
import { checkpointHash, createIdentity, encodeRecord, issueCheckpoint } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { BridgeOptions } from "../bridge.js";
import type { SnapshotInstalled } from "../join.js";
import type { Peer } from "./fixtures.js";

import { bridgeFramedLink } from "../bridge.js";
import { decodeFrame } from "../frame.js";
import { loopbackPair } from "../link.js";
import { ACME, BODY, GLOBEX, NOTES, T0, key, peer, write } from "./fixtures.js";

interface JoinOptions {
  /** Pages of this size, so a test can prove the paging rather than assume it. */
  readonly rowsPerChunk?: number;
  /** Drops the chunk frames whose index this names, once each — a page lost in flight. */
  readonly drop?: readonly number[];
  /** What the holder relays with its state (book ch. 4). */
  readonly certificate?: () => Uint8Array | undefined;
  /** Whose certificate the joiner believes. */
  readonly trust?: PeerId;
}

/**
 * Two bridged peers with a joiner that asks for state — over a link that carries **no events at
 * all**. That is the point of the harness: whatever the joiner ends up holding it got from the
 * snapshot, because the ordinary history path was never available to it. The link also counts the
 * pages it carries and can swallow one, which is how a page lost in flight is expressed here.
 */
const connect = (holder: Peer, joiner: Peer, options: JoinOptions = {}) => {
  const { a, b, control } = loopbackPair();
  const installed: SnapshotInstalled[] = [];
  let chunks = 0;
  const dropped = new Set(options.drop ?? []);
  const historyless = {
    ...a,
    send: (bytes: Uint8Array) => {
      const frame = decodeFrame(bytes);
      if (frame.isErr()) return a.send(bytes);
      if (frame.value.kind === "event") return; // state, not history
      if (frame.value.kind !== "snap-chunk") return a.send(bytes);
      const index = chunks++;
      if (dropped.delete(index)) return;
      return a.send(bytes);
    },
  };
  const side = (p: Peer, link: typeof a, extra: Partial<BridgeOptions> = {}) =>
    bridgeFramedLink(link, {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      now: () => T0,
      ...extra,
    });
  const paging = options.rowsPerChunk === undefined ? {} : { rowsPerChunk: options.rowsPerChunk };
  const vouching =
    options.certificate === undefined ? paging : { ...paging, certificate: options.certificate };
  const held = side(holder, historyless, vouching);
  const believing: Partial<BridgeOptions> = {
    onSnapshot: (report: SnapshotInstalled) => void installed.push(report),
  };
  if (options.trust !== undefined) Object.assign(believing, { trust: options.trust });
  const joined = side(joiner, b, believing);
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) {
      await control.flush();
      await held.flush();
      await joined.flush();
    }
  };
  return {
    installed,
    settle,
    request: (interest?: Interest, adoptUnvouched?: boolean) =>
      joined.requestSnapshot(interest, adoptUnvouched),
    chunkCount: () => chunks,
    close: () => [held.close(), joined.close()],
  };
};

describe("the join exchange", () => {
  test("state instead of history: the rows arrive and the coverage comes with them", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    for (let i = 1; i <= 12; i += 1) (await write(holder, `n${i}`, `body ${i}`)).unwrap();

    const link = connect(holder, joiner);
    link.request();
    await link.settle();

    expect(readRow(joiner.engine.state(), NOTES, key("n7"))?.get(BODY)).toBe("body 7");
    expect(link.installed).toEqual([{ rows: 12, provisional: true }]);
    // the coverage travelled with the rows, so the joiner never asks for those events
    expect(Number(joiner.engine.coverage().synced.get(holder.identity.peerId))).toBe(12);
    // and it holds no log of its own: it has state it never replayed
    expect((await joiner.engine.eventsSince(new Map())).unwrap()).toEqual([]);
    link.close();
  });

  test("an unasked-for join takes the rows as a head start, not as a reason to skip history", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    for (let i = 1; i <= 12; i += 1) (await write(holder, `n${i}`, `body ${i}`)).unwrap();

    const link = connect(holder, joiner);
    // what `joinIfEmpty` asks: nobody chose this, so unvouched state must not retire history
    link.request(undefined, false);
    await link.settle();

    // the rows are in — they merge like any other source, and a later event still wins
    expect(readRow(joiner.engine.state(), NOTES, key("n7"))?.get(BODY)).toBe("body 7");
    expect(link.installed).toEqual([{ rows: 12, provisional: true }]);
    // but the coverage was not bought: the joiner still asks for every one of those events
    expect(joiner.engine.coverage().synced.get(holder.identity.peerId)).toBeUndefined();
    link.close();
  });

  test("a snapshot is paged, and the pages are only adopted once all of them are in", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    for (let i = 1; i <= 10; i += 1) (await write(holder, `n${i}`, `body ${i}`)).unwrap();

    const link = connect(holder, joiner, { rowsPerChunk: 3 });
    link.request();
    await link.settle();

    expect(link.chunkCount()).toBe(4); // ten rows in pages of three
    expect(link.installed[0]?.rows).toBe(10);
    expect(joiner.engine.state().get(NOTES)?.size).toBe(10);
    link.close();
  });

  test("a dropped page is re-requested by index, and the join still completes", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    for (let i = 1; i <= 10; i += 1) (await write(holder, `n${i}`, `body ${i}`)).unwrap();

    // the second page never arrives; the joiner notices at the last one and asks for it again
    const link = connect(holder, joiner, { rowsPerChunk: 3, drop: [1] });
    link.request();
    await link.settle();

    expect(link.chunkCount()).toBe(5); // four pages, one of them sent twice
    expect(joiner.engine.state().get(NOTES)?.size).toBe(10);
    expect(link.installed).toEqual([{ rows: 10, provisional: true }]);
    link.close();
  });

  test("nothing is installed until the set is whole: a lost last page adopts no coverage", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    for (let i = 1; i <= 6; i += 1) (await write(holder, `n${i}`, `body ${i}`)).unwrap();

    // the final page is what goes missing, so there is nothing left to notice it with — and the
    // joiner holds nothing rather than a coverage its rows do not back
    const link = connect(holder, joiner, { rowsPerChunk: 3, drop: [1] });
    link.request();
    await link.settle();

    expect(joiner.engine.state().get(NOTES)).toBeUndefined();
    expect(joiner.engine.coverage().synced.size).toBe(0);
    expect(link.installed).toEqual([]);
    link.close();
  });

  test("an interest narrows the join, and the snapshot says which slice it is complete for", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    (await write(holder, "n1", "acme")).unwrap();
    (await write(holder, "g1", "globex", GLOBEX)).unwrap();

    const link = connect(holder, joiner);
    link.request({ partitions: [ACME] });
    await link.settle();

    expect(joiner.engine.state().get(NOTES)?.size).toBe(1);
    expect(readRow(joiner.engine.state(), NOTES, key("n1"))?.get(BODY)).toBe("acme");
    expect(link.installed[0]?.scope?.partitions?.map(String)).toEqual(["org:acme"]);
    link.close();
  });

  test("two interests converge once they meet: widening asks again rather than assuming", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    (await write(holder, "n1", "acme")).unwrap();
    (await write(holder, "g1", "globex", GLOBEX)).unwrap();

    const link = connect(holder, joiner);
    link.request({ partitions: [ACME] });
    await link.settle();
    expect(joiner.engine.state().get(NOTES)?.size).toBe(1);

    // the coverage it adopted says it has both events, which is true of the *events* and not of
    // the rows it kept — so widening is a fresh request, never an assumption that it is up to date
    expect(Number(joiner.engine.coverage().synced.get(holder.identity.peerId))).toBe(2);
    link.request();
    await link.settle();

    expect(joiner.engine.state().get(NOTES)?.size).toBe(2);
    expect(joiner.engine.digest().get(NOTES)).toBe(holder.engine.digest().get(NOTES));
    link.close();
  });

  test("an empty snapshot is a completed join, not a stalled one", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    const link = connect(holder, joiner);
    link.request();
    await link.settle();
    expect(link.installed).toEqual([{ rows: 0, provisional: true }]);
    link.close();
  });
});

describe("who vouches for a snapshot (book ch. 4)", () => {
  /** The rows the holder is about to send, hashed the way a receiver will hash them. */
  const stateOf = (holder: Peer) =>
    [...holder.engine.state()].flatMap(([table, rows]) =>
      [...rows].map(([key, record]) => ({
        table: String(table),
        key: String(key),
        record: encodeRecord(record),
      })),
    );

  test("a verified certificate makes the install no longer provisional", async () => {
    const authority = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)).unwrap();
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    for (let i = 1; i <= 4; i += 1) (await write(holder, `n${i}`, `body ${i}`)).unwrap();

    const certificate = issueCheckpoint(authority, {
      stateHash: checkpointHash(stateOf(holder)),
      coverage: new Map([[holder.identity.peerId, 4]]),
      now: T0,
    });
    const link = connect(holder, joiner, {
      certificate: () => certificate,
      trust: authority.peerId,
    });
    link.request();
    await link.settle();

    expect(link.installed).toEqual([{ rows: 4, provisional: false }]);
    link.close();
  });

  test("a certificate from anyone but the trusted issuer leaves it provisional", async () => {
    const authority = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)).unwrap();
    const impostor = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 200 - i)).unwrap();
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    (await write(holder, "n1", "body 1")).unwrap();

    // the relaying peer mints its own over the very same rows: the hash is right, the key is not
    const forged = issueCheckpoint(impostor, {
      stateHash: checkpointHash(stateOf(holder)),
      coverage: new Map([[holder.identity.peerId, 1]]),
      now: T0,
    });
    const link = connect(holder, joiner, {
      certificate: () => forged,
      trust: authority.peerId,
    });
    link.request();
    await link.settle();

    expect(link.installed).toEqual([{ rows: 1, provisional: true }]);
    link.close();
  });

  test("no certificate at all is provisional, exactly as it always was", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    (await write(holder, "n1", "body 1")).unwrap();
    const link = connect(holder, joiner);
    link.request();
    await link.settle();
    expect(link.installed).toEqual([{ rows: 1, provisional: true }]);
    link.close();
  });
});
