import type { ColumnName, Procedure, RowKey, TableName } from "@syncmesh/kernel";

import { readRow } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";

import type { Peer } from "../test-fixtures/index.js";

import { bridgeFramedLink } from "../bridge.js";
import { loopbackPair } from "../link.js";
import { ACME, T0 } from "../test-fixtures/index.js";

export * from "../test-fixtures/index.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures; the naming rules are not what these tests are about */
export const NOTES = "notes" as TableName;
export const ID = "id" as ColumnName;
export const BODY = "body" as ColumnName;
export const CREATE = "notes.create" as Procedure;
export const key = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** One row into one peer's log — the write every bridge test syncs. */
export const write = (p: Peer, id: string, body: string, partition = ACME) =>
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

/** What a peer's state says that row's body is, or `undefined` where the row never arrived. */
export const bodyOf = (p: Peer, id: string) => readRow(p.engine.state(), NOTES, key(id))?.get(BODY);

/** Two peers bridged over one loopback, and the rounds that settle whatever they owe each other. */
export const connect = (x: Peer, y: Peer) => {
  const { a, b, control } = loopbackPair();
  const bridgeFor = (p: Peer, link: Parameters<typeof bridgeFramedLink>[0]) =>
    bridgeFramedLink(link, {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      now: () => T0,
    });
  const bx = bridgeFor(x, a);
  const by = bridgeFor(y, b);
  // one round per hop a frame can cause: cursors → events → cursors-back → events. Anything
  // needing more rounds than that is a bridge bug, not a test-timing problem.
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await control.flush();
      await bx.flush();
      await by.flush();
    }
  };
  return { bx, by, control, settle };
};

export { seed };
