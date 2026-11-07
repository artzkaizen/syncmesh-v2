import type { ColumnName } from "@syncmesh/kernel";
import type { WindowRow } from "@syncmesh/window";

import { createServerWindows, decodeWindowFrame } from "@syncmesh/window";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ALICE,
  BOB,
  POSTGRES_URL,
  after,
  eventually,
  mailId,
  pipe,
  seedMailbox,
  served,
} from "./served-fixtures.js";

const suite = POSTGRES_URL === undefined ? describe.skip : describe;

/* oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the mail table's own column */
const SUBJECT = "subject" as ColumnName;

type Fixture = Awaited<ReturnType<typeof served>>;

const ids = (rows: readonly WindowRow[]) => rows.map((r) => r.key);
/** `n` ids counting down from mail `from`: a newest-first page. */
const down = (from: number, n: number) => Array.from({ length: n }, (_, i) => mailId(from - i));
const inbox = (limit: number, cursor?: number) => ({
  path: "mail.inbox",
  input:
    cursor === undefined
      ? { folder: "inbox", limit }
      : { folder: "inbox", limit, after: after(cursor) },
});

/** Every key any frame since `from` put: what a test reads to prove a row never travelled. */
const putSince = (frames: readonly Uint8Array[], from: number) =>
  frames.slice(from).flatMap((bytes) => {
    const frame = decodeWindowFrame(bytes).unwrap();
    return frame?.kind === "rows" ? frame.puts.map((p) => p.key) : [];
  });

suite("served reads over a real Postgres and its logical replication (D43, E27)", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await served({
      seed: async (pg, mail) => {
        await seedMailbox(100)(pg, mail);
        // bob's mail is newer than all of alice's and in the same folder
        await pg.unsafe(
          `INSERT INTO ${mail} SELECT 'b-' || n, 'bob', 'inbox', $1::timestamptz, 'bob ' || n FROM generate_series(1, 5) n`,
          ["2027-01-01T00:00:00Z"],
        );
      },
    });
  });
  afterEach(() => fx.close());

  test("opening a page sends the reader's newest rows once, as a reset; the read rule decides first", async () => {
    const { client, server, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    expect(ids(client.rows("inbox"))).toEqual(down(100, 5));
    expect(decodeWindowFrame(frames.at(-1) ?? new Uint8Array()).unwrap()).toMatchObject({
      kind: "rows",
      reset: true,
      version: 1,
    });
    const bob = pipe(fx.sourceFor(BOB));
    bob.client.open("inbox", inbox(5));
    await bob.server.idle();
    expect(ids(bob.client.rows("inbox"))).toEqual(["b-5", "b-4", "b-3", "b-2", "b-1"]);
  });

  test("the next page is the input's `after`; a half page sends only the rows new to the socket", async () => {
    const { client, server, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(6));
    await server.idle();
    client.open("inbox", inbox(6, 97));
    await server.idle();
    expect(ids(client.rows("inbox"))).toEqual(down(96, 6));
    const half = decodeWindowFrame(frames.at(-1) ?? new Uint8Array()).unwrap();
    if (half?.kind !== "rows") throw new Error("expected a rows frame");
    expect(half.puts.map((p) => p.key)).toEqual(down(94, 4));
    expect(half.dels.map((d) => d.key)).toEqual(down(100, 4));
    client.open("inbox", inbox(6, 91));
    await server.idle();
    expect(ids(client.rows("inbox"))).toEqual(down(90, 6));
    expect(server.held()).toBe(6);
  });

  test("an INSERT inside the page arrives live; one below a full page never travels", async () => {
    const { client, server, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    await fx.insert(101);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(101), "the insert to arrive");
    expect(ids(client.rows("inbox"))).toEqual(down(101, 5));
    const mark = frames.length;
    // older than every row on the page: below a full page, so the page cannot move
    await fx.pg.unsafe(
      `INSERT INTO ${fx.names.mail} VALUES ('old-1', 'alice', 'inbox', '2025-06-01T00:00:00Z', 'old')`,
    );
    await fx.insert(102);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(102), "the second insert");
    await server.idle();
    expect(putSince(frames, mark)).toEqual([mailId(102)]);
    expect(putSince(frames, 0)).not.toContain("old-1");
    expect(server.held()).toBe(5);
  });

  test("a DELETE inside the page pulls the next row up; one below it sends no row", async () => {
    const { client, server, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    await fx.pg.unsafe(`DELETE FROM ${fx.names.mail} WHERE id = $1`, [mailId(98)]);
    await eventually(() => !ids(client.rows("inbox")).includes(mailId(98)), "the delete");
    expect(ids(client.rows("inbox"))).toEqual([100, 99, 97, 96, 95].map(mailId));
    const mark = frames.length;
    await fx.pg.unsafe(`DELETE FROM ${fx.names.mail} WHERE id = $1`, [mailId(10)]);
    await fx.insert(103);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(103), "the marker");
    expect(putSince(frames, mark)).toEqual([mailId(103)]);
  });

  test("an UPDATE out of the handler's `where` leaves the page; back in, it returns", async () => {
    const { client, server } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(3));
    await server.idle();
    const move = (n: number, folder: string) =>
      fx.pg.unsafe(`UPDATE ${fx.names.mail} SET folder = $1 WHERE id = $2`, [folder, mailId(n)]);
    await move(99, "archive");
    await eventually(
      () => ids(client.rows("inbox")).join() === [100, 98, 97].map(mailId).join(),
      "leaving",
    );
    await move(99, "inbox");
    await eventually(() => ids(client.rows("inbox")).join() === down(100, 3).join(), "returning");
    await fx.pg.unsafe(`UPDATE ${fx.names.mail} SET subject = 'renamed' WHERE id = $1`, [
      mailId(100),
    ]);
    await eventually(() => client.rows("inbox")[0]?.row.get(SUBJECT) === "renamed", "the rename");
  });

  test("another reader's rows never enter, even newest and in the folder; their INSERT sends nothing", async () => {
    const { client, server, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    const mark = frames.length;
    await fx.pg.unsafe(
      `INSERT INTO ${fx.names.mail} VALUES ('b-9', 'bob', 'inbox', '2030-01-01T00:00:00Z', 'newest of all')`,
    );
    await fx.insert(104);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(104), "alice's marker");
    expect(putSince(frames, mark)).toEqual([mailId(104)]);
  });

  test("refused, failing closed: a served table with no read rule, an unknown read, a refused input", async () => {
    const { client, server } = pipe(fx.sourceFor(ALICE));
    client.open("open", { path: "mail.everyone", input: { limit: 5 } });
    client.open("nope", { path: "mail.nope", input: {} });
    client.open("zero", { path: "mail.inbox", input: { folder: "inbox", limit: 0 } });
    client.open("ok", inbox(2));
    await server.idle();
    expect(client.refusal("open")).toBe(`${fx.names.open} has no read rule, so no one may read it`);
    expect(client.refusal("nope")).toBe("no read mail.nope");
    expect(client.refusal("zero")).toBe("Number must be greater than or equal to 1");
    expect(client.rows("open")).toEqual([]);
    expect(ids(client.rows("ok"))).toEqual(down(100, 2));
  });

  test("a lost patch is a gap: the client asks again and the server resnapshots it", async () => {
    const { client, server, loseNext, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    loseNext();
    const mark = frames.length;
    await fx.insert(101);
    await eventually(() => frames.length > mark, "the patch that is lost");
    expect(ids(client.rows("inbox"))).toEqual(down(100, 5));
    await fx.insert(102);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(102), "the resnapshot");
    expect(ids(client.rows("inbox"))).toEqual(down(102, 5));
    expect(client.status()).toBe("live");
  });

  test("a new socket opens several windows again and keeps each on screen until all arrived", async () => {
    const source = fx.sourceFor(ALICE);
    const { client, server } = pipe(source);
    client.open("top", inbox(3));
    client.open("deep", inbox(3, 50));
    await server.idle();
    server.stop();
    client.detach();
    await fx.insert(101);
    const seen: string[][][] = [];
    client.subscribe(() => seen.push([ids(client.rows("top")), ids(client.rows("deep"))]));
    const next = createServerWindows({ source, send: (frame) => client.receive(frame) });
    client.attach((frame) => next.receive(frame));
    await next.idle();
    expect(seen).toEqual([[down(101, 3), down(49, 3)]]);
    expect(client.status()).toBe("live");
    expect(client.held()).toBe(6);
    next.stop();
  });
});
