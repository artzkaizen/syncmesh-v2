import type { DocLogEntry, DocStore, SuiteCase } from "@syncmesh/engine";

import { check, equal, liveStates, openEngine } from "@syncmesh/engine";
import {
  createHlcClock,
  hlcOf,
  parseActionId,
  parseAdapterId,
  parseLineageId,
  type ColumnName,
  type Procedure,
} from "@syncmesh/kernel";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { sqlDocStore } from "../doc-store.js";
import { openStores } from "../open-stores.js";
import { ddlCase } from "./doc-ddl.js";
import { A, B, N1, NOTES, at, seq } from "./fixtures.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- suite fixtures; naming rules are not under test */
const CONTENT = "content" as ColumnName;
const EDIT = "notes.edit" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const LORO = parseAdapterId("loro@1").unwrap();
const L1 = parseLineageId("01".repeat(16)).unwrap();
const L2 = parseLineageId("02".repeat(16)).unwrap();
const DOC = { table: NOTES, key: N1, column: CONTENT };

const entry = (author: typeof A, n: number, extra: Partial<DocLogEntry> = {}): DocLogEntry => ({
  ...DOC,
  author,
  seq: seq(n),
  index: 0,
  hlc: hlcOf(n * 10, 0),
  size: n,
  state: "adapter-missing",
  ...extra,
});

/** Every field an entry has, as one comparable row. */
const flat = (e: DocLogEntry) => [
  e.author,
  e.seq,
  e.index,
  String(e.table),
  String(e.key),
  String(e.column),
  e.lineage ?? null,
  e.hlc[0].epochMilliseconds,
  e.hlc[1],
  e.action ?? null,
  e.undoOf ?? null,
  e.blob ?? null,
  e.size,
  e.state,
];

const open = async (driver: SqlDriver): Promise<DocStore> => (await sqlDocStore(driver)).unwrap();

export const docCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  ddlCase(openDriver),
  {
    name: "docs: entries round-trip every field; append is idempotent and ordered by author, seq, index",
    run: async () => {
      const docs = await open(await openDriver("docs-entries"));
      const full = entry(B, 2, {
        index: 3,
        lineage: L1,
        action: parseActionId("a1".repeat(16)).unwrap(),
        undoOf: parseActionId("b2".repeat(16)).unwrap(),
        blob: "ab".repeat(32),
        size: 70_000,
        state: "bytes-missing",
        hlc: hlcOf(123_456, 7),
      });
      const bare = entry(A, 9);
      (await docs.append([full, bare, entry(A, 1)])).unwrap();
      (await docs.append([bare])).unwrap();
      const held = (await docs.entries()).unwrap();
      equal(held.length, 3, "one row per change");
      equal(
        held.map((e) => `${e.author[0]}${e.seq}`),
        ["a1", "a9", "b2"],
        "order",
      );
      equal(flat(held[2] ?? bare), flat(full), "every field of a full entry");
      equal(flat(held[1] ?? full), flat(bare), "every field of a bare one");
    },
  },
  {
    name: "docs: relineage orphans off the winner and revives on it; refreshHead counts the winner's tail",
    run: async () => {
      const docs = await open(await openDriver("docs-lineage"));
      const live = liveStates(false);
      (
        await docs.append([
          entry(A, 1),
          entry(A, 2, { lineage: L1 }),
          entry(B, 1, { lineage: L2, blob: "cd".repeat(32) }),
        ])
      ).unwrap();
      (await docs.relineage(DOC, L1, live)).unwrap();
      const states = async () => (await docs.entries()).unwrap().map((e) => e.state);
      equal(await states(), ["orphaned", "adapter-missing", "orphaned"], "L1 wins");
      (await docs.refreshHead(DOC, LORO, L1)).unwrap();
      (await docs.relineage(DOC, L2, liveStates(true))).unwrap();
      equal(await states(), ["orphaned", "orphaned", "bytes-missing"], "L2 wins");
      (await docs.refreshHead(DOC, LORO, L2)).unwrap();
      const [head] = (await docs.heads()).unwrap();
      equal(head?.lineage ?? null, L2, "head lineage");
      equal([head?.tailCount ?? -1, head?.tailBytes ?? -1], [1, 1], "tail");
      equal(
        [head?.mode ?? "", head?.covers.size ?? -1, head?.version ?? null],
        ["none", 0, null],
        "no snapshot yet",
      );
      equal((await docs.heads()).unwrap().length, 1, "one head per document");
    },
  },
  {
    name: "docs: uncoveredFloor stops each author below its lowest entry no snapshot covers",
    run: async () => {
      const docs = await open(await openDriver("docs-floor"));
      (
        await docs.append([
          entry(A, 3),
          entry(A, 5),
          entry(B, 1, { state: "covered" }),
          entry(B, 4),
        ])
      ).unwrap();
      const floor = (await docs.uncoveredFloor()).unwrap();
      equal([floor.get(A) ?? null, floor.get(B) ?? null], [seq(2), seq(3)], "floors");
    },
  },
  {
    name: "docs: an engine over openStores appends its doc log in the write's transaction, and a reopen finds it",
    run: async () => {
      const docs = new Map([[NOTES, new Map([[CONTENT, LORO]])]]);
      const boot = async (driver: SqlDriver) => {
        const stores = (await openStores(driver)).unwrap();
        const engine = (
          await openEngine({
            peerId: A,
            clock: createHlcClock({ now: () => at(1_000) }),
            store: stores.events,
            stateStore: stores.state,
            atomic: stores.atomic,
            docStore: stores.docs,
            docs,
          })
        ).unwrap();
        return { engine, stores };
      };
      const first = await boot(await openDriver("docs-engine"));
      const write = await first.engine.mutate(EDIT, (tx) =>
        tx.doc(NOTES, N1, {
          column: CONTENT,
          adapter: LORO,
          update: { bytes: Uint8Array.of(1) },
          genesis: true,
        }),
      );
      check(write.isOk(), "the write lands");
      await first.stores.close();
      const again = await boot(await openDriver("docs-engine"));
      const log = (await again.engine.docLog()).unwrap();
      equal(
        log.map((e) => [e.author, e.seq, e.state]),
        [[A, seq(1), "adapter-missing"]],
        "entry",
      );
      const [head] = (await again.engine.docHeads()).unwrap();
      equal(head?.lineage ?? null, log[0]?.lineage ?? "", "head names the genesis's lineage");
    },
  },
];
