import type { Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { LineageCellRefused, readRow } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import {
  checkpointHash,
  createIdentity,
  encodeRecord,
  encodeSnapshotRows,
  issueCheckpoint,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { BridgeError, BridgeOptions } from "../bridge.js";
import type { JoinExchange, JoinOutcome, JoinPolicy, SnapshotInstalled } from "../join.js";
import type { Peer } from "./fixtures.js";

import { bridgeFramedLink } from "../bridge.js";
import { cursorsFrame, decodeFrame } from "../frame.js";
import { createJoinExchange } from "../join.js";
import { loopbackPair } from "../link.js";
import { snapChunkFrame, snapManifestFrame } from "../snap-frame.js";
import { ACME, BODY, CREATE, GLOBEX, NOTES, T0, key, mintFor, peer, write } from "./fixtures.js";

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
  const errors: BridgeError[] = [];
  joined.onError((error) => void errors.push(error));
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) {
      await control.flush();
      await held.flush();
      await joined.flush();
    }
  };
  return {
    installed,
    errors,
    settle,
    request: (interest?: Interest, adoptUnvouched?: boolean) =>
      joined.requestSnapshot(interest, adoptUnvouched),
    chunkCount: () => chunks,
    close: () => [held.close(), joined.close()],
  };
};

/** The rows a holder is about to send, hashed the way a receiver will hash them. */
const stateOf = (holder: Peer) =>
  [...holder.engine.state()].flatMap(([table, rows]) =>
    [...rows].map(([key, record]) => ({
      table: String(table),
      key: String(key),
      record: encodeRecord(record),
    })),
  );

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

  test("a snapshot the engine refuses is closed, adopts nothing, and is said on onError", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    (await write(holder, "n1", "body 1")).unwrap();
    const refusal = new LineageCellRefused({
      table: "notes",
      key: "n1",
      column: "content",
      version: 2,
      message: "notes/n1.content: a lineage cell of version 2; this build runs version 1",
    });
    const refusing = {
      ...joiner,
      engine: {
        ...joiner.engine,
        installSnapshot: () => Promise.resolve(Result.err(refusal)),
      },
    };
    const link = connect(holder, refusing, { rowsPerChunk: 1 });
    link.request();
    await link.settle();
    expect(link.installed).toEqual([]);
    expect(link.errors).toEqual([refusal]);
    expect(joiner.engine.coverage().synced.size).toBe(0);
    expect(link.chunkCount()).toBe(1); // the ack closed the exchange: no page was sent again
    link.close();
  });
});

describe("only an answer is taken (D46, gaps U20)", () => {
  /** A victim bridge whose far side is raw: whatever the test writes there arrives as-is. */
  const rawFarSide = (victim: Peer, trust?: PeerId) => {
    const { a, b, control } = loopbackPair();
    const installed: SnapshotInstalled[] = [];
    const options: BridgeOptions = {
      engine: victim.engine,
      identity: victim.identity,
      grants: victim.grants,
      now: () => T0,
      onSnapshot: (report) => void installed.push(report),
    };
    const bridge = bridgeFramedLink(b, trust === undefined ? options : { ...options, trust });
    const settle = async () => {
      for (let round = 0; round < 4; round += 1) {
        await control.flush();
        await bridge.flush();
      }
    };
    return { send: (bytes: Uint8Array) => a.send(bytes), installed, settle, bridge };
  };

  for (const trusted of [false, true]) {
    test(`a manifest nobody asked for installs nothing and adopts nothing (trust ${trusted ? "set" : "absent"})`, async () => {
      const authority = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)).unwrap();
      const victim = peer(80, "acct_y");
      const author = peer(40, "acct_x");
      (await write(victim, "mine", "kept")).unwrap();
      const before = victim.engine.coverage().synced;
      const far = rawFarSide(victim, trusted ? authority.peerId : undefined);
      await far.settle();

      // no snap-req was ever sent: an empty manifest with a huge `at`, and one with a page of rows
      // SAFETY: test fixture; a sequence far past any the author wrote
      const huge = new Map([[author.identity.peerId, 1_000_000 as SeqNum]]);
      far.send(snapManifestFrame("evil:1", 0, 0, huge));
      (await write(author, "forged", "planted")).unwrap();
      const rows = author.engine.snapshot().rows;
      far.send(snapManifestFrame("evil:2", 1, rows.length, huge));
      far.send(snapChunkFrame("evil:2", 0, encodeSnapshotRows(rows)));
      await far.settle();

      expect(far.installed).toEqual([]);
      expect(victim.engine.coverage().synced.get(author.identity.peerId)).toBeUndefined();
      expect(victim.engine.coverage().synced).toEqual(before);
      expect(readRow(victim.engine.state(), NOTES, key("forged"))).toBeUndefined();
      far.bridge.close();
    });
  }

  for (const asking of ["a floor", "a cold join"] as const)
    test(`a vouched answer to ${asking} adopts what the certificate signs, not the manifest's \`at\``, async () => {
      const authority = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)).unwrap();
      const victim = peer(80, "acct_y");
      const author = peer(40, "acct_x");
      for (let i = 1; i <= 3; i += 1) (await write(author, `n${i}`, `body ${i}`)).unwrap();
      const rows = author.engine.snapshot().rows;
      const a = author.identity.peerId;
      // a genuine certificate over the author's real rows, covering its three events
      const certificate = issueCheckpoint(authority, {
        stateHash: checkpointHash(stateOf(author)),
        coverage: new Map([[a, 3]]),
        now: T0,
      });
      const far = rawFarSide(victim, authority.peerId);
      await far.settle();

      // SAFETY: test fixture; a sequence far past any the author wrote
      const huge = new Map([[a, 1_000_000 as SeqNum]]);
      // the victim asks, prompted by a claimed floor or as `joinIfEmpty` does; the far side answers
      // with the genuine certificate over the genuine rows, and an `at` nobody signed
      if (asking === "a floor") far.send(cursorsFrame(a, huge, new Map(), huge));
      else far.bridge.requestSnapshot(undefined, false);
      await far.settle();
      far.send(snapManifestFrame("evil:1", 1, rows.length, huge, undefined, certificate));
      far.send(snapChunkFrame("evil:1", 0, encodeSnapshotRows(rows)));
      await far.settle();

      expect(far.installed).toEqual([{ rows: 3, provisional: false }]);
      expect(Number(victim.engine.coverage().synced.get(a))).toBe(3);
      if (asking === "a floor") expect(Number(victim.engine.floor().get(a))).toBe(3);
      far.bridge.close();
    });

  test("a page numbered past the manifest's count is no page: the set waits for the real one (U35)", async () => {
    const victim = peer(80, "acct_y");
    const author = peer(40, "acct_x");
    for (const k of ["n1", "n2"]) (await write(author, k, k)).unwrap();
    const rows = author.engine.snapshot().rows;
    const far = rawFarSide(victim);
    await far.settle();
    far.bridge.requestSnapshot(undefined, true);
    await far.settle();
    // SAFETY: test fixture; the author wrote two events
    const at = new Map([[author.identity.peerId, 2 as SeqNum]]);
    far.send(snapManifestFrame("x:1", 2, rows.length, at));
    far.send(snapChunkFrame("x:1", 0, encodeSnapshotRows(rows.slice(0, 1))));
    far.send(snapChunkFrame("x:1", 7, encodeSnapshotRows(rows.slice(1))));
    await far.settle();
    expect(far.installed).toEqual([]);
    expect(victim.engine.coverage().synced.get(author.identity.peerId)).toBeUndefined();

    far.send(snapChunkFrame("x:1", 1, encodeSnapshotRows(rows.slice(1))));
    await far.settle();
    expect(far.installed).toEqual([{ rows: 2, provisional: true }]);
    far.bridge.close();
  });

  test("two requests overlapping on one bridge each install under their own policy", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    for (let i = 1; i <= 3; i += 1) (await write(holder, `n${i}`, `body ${i}`)).unwrap();

    const link = connect(holder, joiner);
    // a rebuild that takes unvouched state, then a cold join that does not, both in flight: the
    // first manifest answers the first ask. One shared variable made both installs take the last
    link.request(undefined, true);
    link.request(undefined, false);
    await link.settle();

    expect(link.installed).toEqual([
      { rows: 3, provisional: true },
      { rows: 3, provisional: true },
    ]);
    expect(Number(joiner.engine.coverage().synced.get(holder.identity.peerId))).toBe(3);
    link.close();
  });
});

describe("what an install below a floor adopts (D46)", () => {
  /** Two join exchanges wired back to back, the joiner asking under a whole policy. */
  const exchanges = (holder: Peer, joiner: Peer, joinerEngine = joiner.engine) => {
    const queue: (() => Promise<void>)[] = [];
    const route = (to: () => JoinExchange) => (_what: string, bytes: Uint8Array) => {
      const frame = decodeFrame(bytes).unwrap();
      if (frame.kind.startsWith("snap-"))
        // SAFETY: a frame whose kind starts with "snap-" is a SnapshotFrame (`dispatch.ts`)
        queue.push(() => to().dispatch(frame as Parameters<JoinExchange["dispatch"]>[0]));
    };
    const outcomes: JoinOutcome[] = [];
    const held: JoinExchange = createJoinExchange({
      engine: holder.engine,
      send: route(() => joined),
      idPrefix: "holder",
    });
    const joined: JoinExchange = createJoinExchange({
      engine: joinerEngine,
      send: route(() => held),
      idPrefix: "joiner",
    });
    const settle = async () => {
      while (queue.length > 0) await queue.shift()?.();
    };
    const ask = (policy: Omit<JoinPolicy, "settled">, interest?: Interest) =>
      joined.requestUnder(interest, {
        ...policy,
        settled: (outcome) => void outcomes.push(outcome),
      });
    return { ask, settle, outcomes };
  };

  test("unvouched and accepted: per author at most the claimed floor, and nothing for the rest", async () => {
    const holder = peer(40, "acct_x");
    const other = peer(120, "acct_z");
    const joiner = peer(80, "acct_y");
    for (let i = 1; i <= 5; i += 1) (await write(holder, `n${i}`, `body ${i}`)).unwrap();
    for (let i = 1; i <= 3; i += 1) (await write(other, `o${i}`, `other ${i}`)).unwrap();
    holder.grants.register(mintFor(other.identity, "acct_z")).unwrap();
    (
      await holder.engine.receiveBatch((await other.engine.eventsSince(new Map())).unwrap())
    ).unwrap();
    expect(Number(holder.engine.coverage().synced.get(other.identity.peerId))).toBe(3);
    const x = holder.identity.peerId;

    const pair = exchanges(holder, joiner);
    // SAFETY: test fixture; x wrote five, so 2 is one of its sequences
    pair.ask({ adoptUnvouched: true, floor: new Map([[x, 2 as SeqNum]]) });
    await pair.settle();

    expect(pair.outcomes.map(({ kind }) => kind)).toEqual(["installed"]);
    expect(joiner.engine.state().get(NOTES)?.size).toBe(8);
    // the holder claimed x:5 and z:3; the floor named x:2 and nothing for z
    expect(Number(joiner.engine.coverage().synced.get(x))).toBe(2);
    expect(joiner.engine.coverage().synced.get(other.identity.peerId)).toBeUndefined();
  });

  test("unvouched and not accepted: the rows merge and the coverage stays this device's own", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    for (let i = 1; i <= 3; i += 1) (await write(holder, `n${i}`, `body ${i}`)).unwrap();
    const pair = exchanges(holder, joiner);
    // SAFETY: test fixture; the holder wrote three
    pair.ask({ adoptUnvouched: false, floor: new Map([[holder.identity.peerId, 3 as SeqNum]]) });
    await pair.settle();
    expect(joiner.engine.state().get(NOTES)?.size).toBe(3);
    expect(joiner.engine.coverage().synced.size).toBe(0);
  });

  test("a schema with document columns adopts nothing below a floor: no doc snapshot rides along", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    for (let i = 1; i <= 3; i += 1) (await write(holder, `n${i}`, `body ${i}`)).unwrap();
    const withDocs = { ...joiner.engine, hasDocColumns: () => true };
    const pair = exchanges(holder, joiner, withDocs);
    // SAFETY: test fixture; the holder wrote three
    pair.ask({ adoptUnvouched: true, floor: new Map([[holder.identity.peerId, 3 as SeqNum]]) });
    await pair.settle();
    expect(joiner.engine.state().get(NOTES)?.size).toBe(3);
    expect(joiner.engine.coverage().synced.size).toBe(0);
  });

  test("a sender scoped to another slice claims no coverage for the one asked", async () => {
    const holder = peer(40, "acct_x");
    const joiner = peer(80, "acct_y");
    (await write(holder, "g1", "globex", GLOBEX)).unwrap();
    // the holder joined org:acme only (D23): its cursors are true of that slice and no other
    holder.engine.adoptCoverage({
      ...holder.engine.coverage(),
      scope: JSON.stringify({ partitions: [ACME] }),
    });
    const pair = exchanges(holder, joiner);
    pair.ask(
      // SAFETY: test fixture; the holder wrote one
      { adoptUnvouched: true, floor: new Map([[holder.identity.peerId, 1 as SeqNum]]) },
      { partitions: [GLOBEX] },
    );
    await pair.settle();
    expect(pair.outcomes.map(({ kind }) => kind)).toEqual(["installed"]);
    expect(joiner.engine.coverage().synced.size).toBe(0);
  });
});

describe("a holder under a window (D23, O13)", () => {
  test("holds a row it never had in part, and so claims no coverage for any window it serves", async () => {
    const holder = peer(40, "acct_x");
    const device = peer(80, "acct_y");
    const joiner = peer(81, "acct_z");
    for (const id of ["n1", "n2", "n3"]) (await write(holder, id, `body ${id}`)).unwrap();
    const windowed = { partitions: [ACME], window: { newest: 1 } };
    await device.engine.installSnapshot(holder.engine.snapshot({ interest: windowed }));
    (
      await holder.engine.mutate(
        CREATE,
        (tx) => tx.update(NOTES, key("n1"), new Map([[BODY, "edited"]])),
        { partition: ACME },
      )
    ).unwrap();

    // events are never windowed: the update to n1, a row outside the device's window, folds onto
    // nothing, and the device now holds n1 with the patched cell alone
    const { a, b, control } = loopbackPair();
    const side = (p: Peer, end: typeof a, extra: Partial<BridgeOptions> = {}) =>
      bridgeFramedLink(end, {
        engine: p.engine,
        identity: p.identity,
        grants: p.grants,
        now: () => T0,
        ...extra,
      });
    const bridges = [side(holder, a), side(device, b, { interest: windowed })];
    for (let round = 0; round < 8; round += 1) {
      await control.flush();
      for (const bridge of bridges) await bridge.flush();
    }
    for (const bridge of bridges) bridge.close();
    expect([...(device.engine.state().get(NOTES)?.get(key("n1"))?.cells.keys() ?? [])]).toEqual([
      BODY,
    ]);
    expect(device.engine.snapshot({ interest: windowed }).rows.map((row) => row.key)).toEqual([
      key("n1"),
    ]);

    // so what it serves under a window is rows, never a claim to have them whole
    const link = connect(device, joiner);
    link.request(windowed);
    await link.settle();
    expect(readRow(joiner.engine.state(), NOTES, key("n1"))?.get(BODY)).toBe("edited");
    expect(joiner.engine.coverage().synced.size).toBe(0);
    link.close();
  });
});
