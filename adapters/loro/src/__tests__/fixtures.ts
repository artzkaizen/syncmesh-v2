import type { DocLimits } from "@syncmesh/docs";
import type { Link } from "@syncmesh/engine";

import { createDocuments } from "@syncmesh/docs";
import {
  createEngine,
  createLink,
  createMemoryEventStore,
  createMemoryStateStore,
  createValidator,
} from "@syncmesh/engine";
import {
  createHlcClock,
  parsePartitionKey,
  type ColumnName,
  type Procedure,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";

import { LORO_ID, loro } from "../index.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture names; naming rules are not under test */
export const NOTES = "notes" as TableName;
export const CONTENT = "content" as ColumnName;
export const N1 = "n1" as RowKey;
export const N2 = "n2" as RowKey;
export const EDIT = "notes.edit" as Procedure;
const ID = "id" as ColumnName;
const TITLE = "title" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
export const W1 = parsePartitionKey("workspace:w1").unwrap();
export const DOC = { table: NOTES, key: N1, column: CONTENT };
export const DOCS = new Map([[NOTES, new Map([[CONTENT, LORO_ID]])]]);

const workspace = partition("workspace");
export const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text(), content: t.blob().nullable() },
      partition: workspace,
      allow: ({ allow }) => ({ $default: allow }),
    },
  },
});
export const validate = createValidator({ schema, grantFor: null, docs: DOCS });

/** Pacing a test can wait out: a burst is sent 5 ms after it goes quiet. */
export const FAST = {
  idle: Temporal.Duration.from({ milliseconds: 5 }),
  max: Temporal.Duration.from({ milliseconds: 20 }),
};

export interface NodeOptions {
  readonly adapter?: boolean;
  readonly limits?: Partial<DocLimits>;
}

/** An engine of the mesh with the doc column declared, and the document runtime over it. */
export function node(n: number, options: NodeOptions = {}) {
  const identity = createIdentity(seed(n)).unwrap();
  let ms = 1_700_000_000_000 + n * 1000;
  const now = () => Temporal.Instant.fromEpochMilliseconds((ms += 1));
  const store = createMemoryEventStore();
  const withAdapter = options.adapter !== false;
  const engine = createEngine({
    peerId: identity.peerId,
    clock: createHlcClock({ now }),
    store,
    stateStore: createMemoryStateStore(),
    validate,
    docs: DOCS,
    ...(withAdapter && { docAdapters: new Set([LORO_ID]) }),
  });
  const documents = createDocuments({
    engine,
    adapters: withAdapter ? [loro(options.limits)] : [],
    docs: DOCS,
    procedure: EDIT,
    pacing: FAST,
    now,
  });
  return { identity, engine, store, documents, now };
}

export type Node = ReturnType<typeof node>;

/** Inserts the row a document lives on. */
export const insertNote = async (n: Node) =>
  (
    await n.engine.mutate(
      EDIT,
      (tx) =>
        tx.insert(
          NOTES,
          N1,
          new Map([
            [ID, "n1"],
            [TITLE, "t"],
          ]),
        ),
      { partition: W1 },
    )
  ).unwrap();

/** Links two engines in process, both ways, and waits for them to agree. */
export async function linked(a: Node, b: Node): Promise<Link> {
  const link = createLink(a.engine, b.engine);
  (await link.catchUp()).unwrap();
  return link;
}

/** Polls until `check` holds, or gives up after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}
