import type { SyncEvent } from "@syncmesh/kernel";

import { parsePartitionKey, readRow } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import {
  GENESIS,
  certifyFeed,
  chunkFrom,
  createIdentity,
  encodeEventCore,
  type FeedChunk,
} from "@syncmesh/wire";
import { grownCore } from "@syncmesh/wire/wire-tests";
import { describe, expect, test } from "bun:test";

import type { Validator } from "../validate.js";

import { PolicyDenied } from "../errors.js";
import { CREATE, NOTES, N1, column, key, row, setup } from "./fixtures.js";

const TITLE = column("title");
const ACME = parsePartitionKey("org:acme").unwrap();

const author = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 40 + i)).unwrap();
const impostor = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const bystander = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();

type Side = ReturnType<typeof setup>;

const write = (s: Side, id: string, title: string) =>
  s.engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(id), row({ title })), { partition: ACME });

/** The author's own events, oldest first — what a run is built from. */
const eventsOf = async (s: Side): Promise<readonly SyncEvent[]> =>
  (await s.engine.eventsSince(new Map())).unwrap().map(({ event }) => event);

/** Narrows without asserting: a run this test asked for and did not get is a failure, not a cast. */
const must = (chunk: FeedChunk | undefined): FeedChunk => {
  if (chunk === undefined) throw new Error("expected a run");
  return chunk;
};

/** The certificate the bridge would add: the engine tracks the chain, the key lives elsewhere. */
const certify = (s: Side) =>
  s.engine.rememberCertificate(certifyFeed(author, s.engine.feedHead(author.peerId)));

describe("chunks at the engine", () => {
  test("a joiner takes two hundred events for one verification", async () => {
    const a = setup(author.peerId, 100);
    for (let i = 1; i <= 200; i += 1) (await write(a, `n${i}`, `title ${i}`)).unwrap();

    const cores = (await eventsOf(a)).map((event) => encodeEventCore(event));
    const chunk = chunkFrom(author, GENESIS, cores);

    const b = setup(impostor.peerId, 200);
    const report = (await b.engine.receiveChunk(chunk)).unwrap();
    expect(report.folded).toBe(200);
    expect(readRow(b.engine.state(), NOTES, key("n7"))?.get(TITLE)).toBe("title 7");
  });

  test("the engine's chain is the author's, so a run built from it verifies", async () => {
    const a = setup(author.peerId, 100);
    for (let i = 1; i <= 3; i += 1) (await write(a, `n${i}`, `t${i}`)).unwrap();

    const head = a.engine.feedHead(author.peerId);
    expect(Number(head.seq)).toBe(3);
    // the same head the author would compute itself, which is what makes the certificate meaningful
    expect(head.hash).toEqual(
      chunkFrom(
        author,
        GENESIS,
        (await eventsOf(a)).map((event) => encodeEventCore(event)),
      ).certificate.head.hash,
    );
  });

  test("chunkSince serves a run only once the device holds a certificate for it", async () => {
    const a = setup(author.peerId, 100);
    (await write(a, "n1", "one")).unwrap();
    expect((await a.engine.chunkSince(author.peerId, GENESIS.seq)).unwrap()).toBeUndefined();

    certify(a);
    const chunk = (await a.engine.chunkSince(author.peerId, GENESIS.seq)).unwrap();
    expect(chunk?.cores).toHaveLength(1);

    const b = setup(impostor.peerId, 200);
    expect((await b.engine.receiveChunk(must(chunk))).unwrap().folded).toBe(1);
    expect(readRow(b.engine.state(), NOTES, N1)?.get(TITLE)).toBe("one");
  });

  test("a receiver continues from where its chain is, run after run", async () => {
    const a = setup(author.peerId, 100);
    const b = setup(impostor.peerId, 200);

    (await write(a, "n1", "one")).unwrap();
    certify(a);
    const first = must((await a.engine.chunkSince(author.peerId, GENESIS.seq)).unwrap());
    (await b.engine.receiveChunk(first)).unwrap();

    (await write(a, "n2", "two")).unwrap();
    certify(a);
    const at = b.engine.feedHead(author.peerId);
    expect(Number(at.seq)).toBe(1);
    const second = must((await a.engine.chunkSince(author.peerId, at.seq)).unwrap());
    expect(second.cores).toHaveLength(1); // only what b is missing

    expect((await b.engine.receiveChunk(second)).unwrap().folded).toBe(1);
    expect(b.engine.feedHead(author.peerId).hash).toEqual(a.engine.feedHead(author.peerId).hash);
  });

  test("a run that does not lead to its certificate folds nothing", async () => {
    const a = setup(author.peerId, 100);
    for (let i = 1; i <= 3; i += 1) (await write(a, `n${i}`, `t${i}`)).unwrap();
    const cores = (await eventsOf(a)).map((event) => encodeEventCore(event));
    const chunk = chunkFrom(author, GENESIS, cores);
    // one event swapped for another of the author's own: the head no longer matches
    const tampered: FeedChunk = {
      ...chunk,
      cores: [cores[0], cores[2], cores[1]].filter((c) => c !== undefined),
    };

    const b = setup(impostor.peerId, 200);
    const result = await b.engine.receiveChunk(tampered);
    expect(result.isErr()).toBe(true);
    expect(b.engine.state().get(NOTES)).toBeUndefined();
    expect(Number(b.engine.feedHead(author.peerId).seq)).toBe(0);
  });

  test("a run that skips ahead of the receiver is refused rather than guessed at", async () => {
    const a = setup(author.peerId, 100);
    for (let i = 1; i <= 2; i += 1) (await write(a, `n${i}`, `t${i}`)).unwrap();
    const at = a.engine.feedHead(author.peerId);
    for (let i = 3; i <= 4; i += 1) (await write(a, `n${i}`, `t${i}`)).unwrap();
    const cores = (await eventsOf(a)).map((event) => encodeEventCore(event));

    const b = setup(impostor.peerId, 200);
    // b is at genesis, and this run starts after the author's second event
    const ahead = chunkFrom(author, at, cores.slice(2));
    expect((await b.engine.receiveChunk(ahead)).isErr()).toBe(true);
    expect(b.engine.state().get(NOTES)).toBeUndefined();
  });

  /**
   * The chain is a hash of the bytes each author signed, so a device that re-encoded what it could
   * read of a newer build's event would compute a head the author's certificate never covers —
   * every run that author serves would then be refused, on a device that had folded the events
   * perfectly well. The whole feed path has to carry arrival bytes, not this build's reading.
   */
  test("a run of a newer build's events leaves this device on the author's own chain", async () => {
    const a = setup(author.peerId, 100);
    for (let i = 1; i <= 2; i += 1) (await write(a, `n${i}`, `t${i}`)).unwrap();
    // one map key this decoder has no name for, in every core the author signed
    const cores = (await eventsOf(a)).map((event) => grownCore(encodeEventCore(event)));
    const chunk = chunkFrom(author, GENESIS, cores);

    const b = setup(impostor.peerId, 200);
    expect((await b.engine.receiveChunk(chunk)).unwrap().folded).toBe(2);
    expect(b.engine.feedHead(author.peerId).hash).toEqual(chunk.certificate.head.hash);

    // and the run b serves on is the author's bytes, so a third device verifies it against the
    // author's own certificate — across two engines, not one engine against itself
    b.engine.rememberCertificate(chunk.certificate);
    const served = must((await b.engine.chunkSince(author.peerId, GENESIS.seq)).unwrap());
    expect(served.cores).toEqual(cores);
    const c = setup(bystander.peerId, 300);
    expect((await c.engine.receiveChunk(served)).unwrap().folded).toBe(2);
    expect(c.engine.feedHead(author.peerId).hash).toEqual(chunk.certificate.head.hash);
  });

  test("one signature is not permission: every event still climbs the ladder", async () => {
    const a = setup(author.peerId, 100);
    (await write(a, "n1", "allowed")).unwrap();
    (await write(a, "n2", "denied")).unwrap();
    const chunk = chunkFrom(
      author,
      GENESIS,
      (await eventsOf(a)).map((event) => encodeEventCore(event)),
    );

    const refuse: Validator = {
      validate: (event) =>
        event.changes.some((c) => c.key === key("n2"))
          ? Result.err(
              new PolicyDenied({
                table: String(NOTES),
                key: "n2",
                op: "insert",
                message: "n2 is not yours",
              }),
            )
          : Result.ok(undefined),
    };
    const b = setup(impostor.peerId, 200, { validate: refuse });
    const denied: string[] = [];
    b.engine.onQuarantine(({ reason }) => void denied.push(reason._tag));

    const report = (await b.engine.receiveChunk(chunk)).unwrap();
    expect(report.folded).toBe(1);
    expect(report.quarantined).toBe(1);
    expect(denied).toEqual(["PolicyDenied"]);
    expect(readRow(b.engine.state(), NOTES, key("n2"))).toBeUndefined();
  });
});
