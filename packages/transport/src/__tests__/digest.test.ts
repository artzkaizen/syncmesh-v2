import type { Interest } from "@syncmesh/engine";
import type { RowKey, TableName } from "@syncmesh/kernel";

import { divergentRows, interestKey } from "@syncmesh/engine";
import { parsePartitionKey, readRow, type ColumnName, type Procedure } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import type { Divergence } from "../divergence.js";

import { bridgeFramedLink } from "../bridge.js";
import { loopbackPair } from "../link.js";
import { ACME, T0, peer } from "./fixtures.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const NOTES = "notes" as TableName;
const BODY = "body" as ColumnName;
const ID = "id" as ColumnName;
const CREATE = "notes.create" as Procedure;
const key = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const GLOBEX = parsePartitionKey("org:globex").unwrap();
type Peer = ReturnType<typeof peer>;

const write = (p: Peer, id: string, body: string, partition = ACME) =>
  p.engine.mutate(
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
  );

/** Two bridged peers, each told what slice it syncs, both reporting what they find. */
const connect = (x: Peer, y: Peer, interests: { x?: Interest; y?: Interest } = {}) => {
  const { a, b, control } = loopbackPair();
  const found: Divergence[] = [];
  const side = (p: Peer, link: typeof a, interest: Interest | undefined) => {
    const options = {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      now: () => T0,
      onDivergence: (report: Divergence) => void found.push(report),
    };
    if (interest !== undefined) Object.assign(options, { interest });
    return bridgeFramedLink(link, options);
  };
  const bx = side(x, a, interests.x);
  const by = side(y, b, interests.y);
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) {
      await control.flush();
      await bx.flush();
      await by.flush();
    }
  };
  return { found, settle, close: () => [bx.close(), by.close()] };
};

describe("digests on the wire", () => {
  test("two peers that synced normally agree, and report nothing", async () => {
    const x = peer(40, "acct_x");
    const y = peer(80, "acct_y");
    (await write(x, "n1", "one")).unwrap();
    const link = connect(x, y);
    await link.settle();

    expect(readRow(y.engine.state(), NOTES, key("n1"))?.get(BODY)).toBe("one");
    expect(link.found).toEqual([]); // nothing to report: they hold the same rows
    link.close();
  });

  test("a row one peer holds with no event behind it is reported, narrowed and healed", async () => {
    const x = peer(40, "acct_x");
    const y = peer(80, "acct_y");
    (await write(x, "n1", "one")).unwrap();

    // a row that exists with no event behind it is what a half-finished replication leaves:
    // the logs agree about what each side has seen, and the rows still disagree
    const source = x.engine.rowRecords(NOTES, [key("n1")])[0];
    expect(source).toBeDefined();
    // SAFETY: the write above put this record in x's state, and the assertion just proved it
    const record = (source as NonNullable<typeof source>).record;
    await x.engine.repairRows(NOTES, [{ key: key("ghost"), record }]);

    const link = connect(x, y);
    await link.settle();
    expect(link.found.map((d) => d.tables.map(String))).toContainEqual([String(NOTES)]);

    // and the report is enough to narrow to the row and heal it
    const keys = divergentRows(x.engine.rowDigests(NOTES), y.engine.rowDigests(NOTES));
    expect(keys.map(String)).toEqual(["ghost"]);
    await y.engine.repairRows(NOTES, x.engine.rowRecords(NOTES, keys));
    expect(x.engine.digest().get(NOTES)).toBe(y.engine.digest().get(NOTES));
    link.close();
  });

  test("two peers holding different slices compare nothing — a different scope is not a disagreement", async () => {
    const x = peer(40, "acct_x");
    const y = peer(80, "acct_y");
    (await write(x, "n1", "acme")).unwrap();
    (await write(x, "g1", "globex", GLOBEX)).unwrap();

    // x syncs both boards, y only one: their states will differ, and that means nothing
    const link = connect(x, y, { x: {}, y: { partitions: [ACME] } });
    await link.settle();
    expect(link.found).toEqual([]);
    link.close();
  });

  test("the same slice named the same way is what makes a comparison happen at all", async () => {
    const x = peer(40, "acct_x");
    const y = peer(80, "acct_y");
    (await write(x, "n1", "one")).unwrap();
    const both: Interest = { partitions: [ACME] };
    expect(interestKey(both)).toBe(interestKey({ partitions: [ACME] }));

    const link = connect(x, y, { x: both, y: both });
    await link.settle();
    expect(link.found).toEqual([]); // same scope, same rows

    // give x a row with no event behind it, so the two states differ inside the same slice
    const source = x.engine.rowRecords(NOTES, [key("n1")])[0];
    // SAFETY: the write above put this record in x's state
    const record = (source as NonNullable<typeof source>).record;
    await x.engine.repairRows(NOTES, [{ key: key("ghost"), record }]);
    const again = connect(x, y, { x: both, y: both });
    await again.settle();
    expect(again.found.length).toBeGreaterThan(0); // same scope, different rows
    again.close();
    link.close();
  });
});
