/**
 * The authority-visibility tier (D24) as every suite that exercises it sees it: one manifest with
 * a `global` catalog and a gated consult table, an authority that writes both, and devices that
 * only read. Shared for the reason `peer` is: the relay's gate and a peer link's withholding are
 * one rule, and two fixtures would let them disagree about what the rule is applied to.
 */

import type { Engine } from "@syncmesh/engine";
import type { PeerId, SyncEvent } from "@syncmesh/kernel";

import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import {
  createHlcClock,
  readRow,
  type CellValue,
  type ColumnName,
  type Procedure,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { authorityTables, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity } from "@syncmesh/wire";

import type { TransportContext } from "../transport.js";
import type { Withheld } from "../withheld.js";

export const gatedSchema = syncSchema({
  tables: {
    catalog: { columns: { id: t.text().primaryKey(), body: t.text() } },
    consults: {
      columns: { id: t.text().primaryKey(), clinic: t.text(), body: t.text() },
      visibility: "authority",
    },
  },
});

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
export const CATALOG = "catalog" as TableName;
export const CONSULTS = "consults" as TableName;
const ID = "id" as ColumnName;
const BODY = "body" as ColumnName;
const CLINIC = "clinic" as ColumnName;
const key = (k: string) => k as RowKey;
const procedure = (p: string) => p as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** The authority's key, which every peer's validator names as the only author of both tables. */
export const AUTHORITY = createIdentity(seed(7)).unwrap();

/**
 * One peer over {@link gatedSchema}. `believes` is whom its validator takes for the authority —
 * the real one unless a test is building a forger, which names itself and so signs what nobody
 * else will fold.
 */
export const gatedPeer = (n: number, believes: PeerId = AUTHORITY.peerId, startMs = 100) => {
  const identity = n === 7 ? AUTHORITY : createIdentity(seed(n)).unwrap();
  const grants = createGrantRegistry({
    issuer: AUTHORITY.peerId,
    now: () => Temporal.Now.instant(),
  });
  let ms = startMs;
  const clock = createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms++) });
  const engine = createEngine({
    peerId: identity.peerId,
    clock,
    store: createMemoryEventStore(),
    validate: createValidator({ schema: gatedSchema, grantFor: null, authority: believes }),
  });
  const withheld: Withheld = {
    tables: new Set(authorityTables(gatedSchema)),
    author: AUTHORITY.peerId,
  };
  const context: TransportContext = { engine, identity, grants, withheld };
  return { identity, grants, engine, context };
};

export type GatedPeer = ReturnType<typeof gatedPeer>;

/** Anything with an engine: a fixture peer, or a whole mesh. */
interface HasEngine {
  readonly engine: Engine;
}

/** A catalog row: global, so every device receives it. */
export const writeCatalog = async (p: HasEngine, id: string, body: string) =>
  (
    await p.engine.mutate(procedure("catalog.create"), (tx) =>
      tx.insert(
        CATALOG,
        key(id),
        new Map([
          [ID, id],
          [BODY, body],
        ]),
      ),
    )
  ).unwrap();

/** A consult row: gated, so only the devices entitled to its clinic receive it. */
export const writeConsult = async (p: HasEngine, id: string, clinic: string, body = id) =>
  p.engine.mutate(procedure("consults.create"), (tx) =>
    tx.insert(
      CONSULTS,
      key(id),
      new Map([
        [ID, id],
        [CLINIC, clinic],
        [BODY, body],
      ]),
    ),
  );

/** The ids of one table's rows this peer holds, sorted, so two peers' holdings compare as values. */
export const idsIn = (p: HasEngine, table: TableName): readonly string[] =>
  [...(p.engine.state().get(table)?.keys() ?? [])].map(String).sort();

/** Whether one row is held here at all. */
export const holds = (p: HasEngine, table: TableName, id: string): boolean =>
  readRow(p.engine.state(), table, key(id)) !== undefined;

/** The clinics an event's consult rows name, as cells: what an entitlement in these tests admits on. */
export const clinicsIn = (event: SyncEvent): readonly (CellValue | undefined)[] =>
  event.changes.flatMap((change) =>
    change.table === CONSULTS && change.kind === "insert" ? [change.row.get(CLINIC)] : [],
  );

/** Whether every consult an event writes names one of `clinics`. */
export const onlyClinics = (event: SyncEvent, clinics: readonly string[]): boolean =>
  clinicsIn(event).every((cell) => clinics.some((clinic) => clinic === cell));
