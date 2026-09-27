/**
 * Regenerates conformance/doc-vectors.json from fixed seeds (RFC-0023 §13). Run only when the doc
 * wire deliberately changes (README rule 3): `bun conformance/src/generate-doc-vectors.ts`.
 *
 * Every signature here is Ed25519 over a fixed seed, so it is deterministic: a port reproduces the
 * file byte for byte, cores and signatures alike.
 */
import type { Change, DocChange, SyncEvent } from "@syncmesh/kernel";

import {
  type CellValue,
  eventId,
  hlcOf,
  parseActionId,
  parseAdapterId,
  parseLineageId,
  parseSeqNum,
  type ColumnName,
  type PartitionKey,
  type Procedure,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import {
  bytesToHex,
  createIdentity,
  deriveLineage,
  docChangeId,
  signCheckpoint,
  signEvent,
} from "@syncmesh/wire";

import { wireVectors } from "./vectors.js";

const AUTHOR_SEED = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
const PRODUCER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
const T0 = 1_700_000_000_000;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixed vector names; the rules for these brands live in the schema */
const NOTES = "notes" as TableName;
const N1 = "n1" as RowKey;
const CONTENT = "content" as ColumnName;
const TITLE = "title" as ColumnName;
const WORD_COUNT = "wordCount" as ColumnName;
const PARTITION = "workspace:w1" as PartitionKey;
const procedure = (name: string) => name as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const LORO = parseAdapterId("loro@1").unwrap();
const ACTION = parseActionId("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf").unwrap();
const UNDONE = parseActionId("b0b1b2b3b4b5b6b7b8b9babbbcbdbebf").unwrap();

export function docVectors() {
  const author = createIdentity(AUTHOR_SEED).unwrap();
  const producer = createIdentity(PRODUCER_SEED).unwrap();
  const seq = (n: number) => parseSeqNum(n).unwrap();

  const at = (n: number, extra: Partial<SyncEvent>, changes: readonly Change[]): SyncEvent => ({
    v: 1,
    id: eventId(author.peerId, seq(n)),
    peerId: author.peerId,
    seqNum: seq(n),
    hlc: hlcOf(T0 + n, 0),
    procedure: procedure("notes.edit"),
    partition: PARTITION,
    changes,
    ...extra,
  });

  const doc = (extra: Partial<DocChange> = {}): DocChange => ({
    kind: "doc",
    table: NOTES,
    key: N1,
    column: CONTENT,
    adapter: LORO,
    update: { bytes: Uint8Array.of(0x6c, 0x6f, 0x72, 0x6f) },
    ...extra,
  });
  const genesisLineage = deriveLineage(author.peerId, seq(3), 1);

  const events: readonly (readonly [string, SyncEvent])[] = [
    ["an inline update on the root lineage", at(1, {}, [doc()])],
    [
      "a blob-carried update on a named lineage",
      at(2, {}, [
        doc({
          lineage: parseLineageId("0102030405060708090a0b0c0d0e0f10").unwrap(),
          update: { blob: { hash: "ab".repeat(32), size: 70_000 } },
        }),
      ]),
    ],
    [
      "an insert and a genesis in one event: the lineage derives from change index 1",
      at(3, { procedure: procedure("notes.replace") }, [
        { kind: "insert", table: NOTES, key: N1, row: new Map([[CONTENT, null]]) },
        doc({ lineage: genesisLineage, genesis: true, update: { bytes: Uint8Array.of(1, 2, 3) } }),
      ]),
    ],
    ["an update in an action", at(4, { action: ACTION }, [doc()])],
    [
      "the undo of that action, in an action of its own",
      at(5, { action: UNDONE, undoOf: ACTION, procedure: procedure("revert") }, [doc()]),
    ],
  ];

  const lineages = (
    [
      [author, 1, 0],
      [author, 3, 1],
      [producer, 2 ** 40, 65_535],
    ] as const
  ).map(([who, n, index]) => ({
    peerId: who.peerId,
    seq: n,
    index,
    changeIdHex: bytesToHex(docChangeId(who.peerId, seq(n), index)),
    lineageHex: deriveLineage(who.peerId, seq(n), index),
  }));

  const checkpoint = signCheckpoint(
    {
      table: NOTES,
      key: N1,
      column: CONTENT,
      adapter: LORO,
      lineage: genesisLineage,
      covers: new Map([
        [author.peerId, seq(5)],
        [producer.peerId, seq(2)],
      ]),
      version: Uint8Array.of(0x01, 0x05),
      snapshot: { hash: "cd".repeat(32), size: 4_096 },
      derived: new Map<ColumnName, CellValue>([
        [TITLE, "Q3"],
        [WORD_COUNT, 812],
      ]),
      at: hlcOf(T0 + 10, 1),
    },
    producer,
  );

  const frozen = wireVectors.vectors[0];
  return {
    authorId: author.peerId,
    producerId: producer.peerId,
    events: events.map(([description, event]) => {
      const signed = signEvent(event, author);
      return { description, coreHex: bytesToHex(signed.core), sigHex: bytesToHex(signed.sig) };
    }),
    lineages,
    checkpoint: {
      description: "a checkpoint of the genesis lineage, covering both writers",
      coreHex: bytesToHex(checkpoint.core),
      sigHex: bytesToHex(checkpoint.sig),
    },
    v1: {
      description: `wire-vectors.json "${frozen?.description ?? ""}", re-verified under the doc codec`,
      coreHex: frozen?.coreHex ?? "",
    },
  };
}

if (import.meta.main) {
  const out = new URL("../doc-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(docVectors(), null, 2)}\n`);
}
