import type { BackgroundError, DocLimits } from "@syncmesh/docs";
import type { Link } from "@syncmesh/engine";
import type { LoroDoc } from "loro-crdt";

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
  readonly onError?: (error: BackgroundError) => void;
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
    ...(options.onError !== undefined && { onError: options.onError }),
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

/** The text a test types into: the document's `body`. */
export const body = (doc: LoroDoc) => doc.getText("body").toString();

/** Types `text` at `at` and commits it, as an editor would. */
export const type = (doc: LoroDoc, at: number, text: string) => {
  doc.getText("body").insert(at, text);
  doc.commit();
};

/**
 * A second document runtime over `n`'s engine whose every read of a tail is held after it is
 * taken, until `release`: what lands meanwhile lands between that read and what is built on it.
 */
export function heldTail(n: Node) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const documents = createDocuments({
    engine: {
      ...n.engine,
      docTail: async (doc) => {
        const tail = await n.engine.docTail(doc);
        await held;
        return tail;
      },
    },
    adapters: [loro()],
    docs: DOCS,
    procedure: EDIT,
    pacing: FAST,
    autoMaterialise: false,
  });
  return { documents, release: () => release() };
}
