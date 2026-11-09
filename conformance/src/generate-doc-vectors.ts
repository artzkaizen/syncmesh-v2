/**
 * Regenerates conformance/doc-vectors.json from fixed seeds (RFC-0023 §13). Run only when the doc
 * wire deliberately changes (README rule 3): `bun conformance/src/generate-doc-vectors.ts`.
 *
 * Every signature here is Ed25519 over a fixed seed, so it is deterministic: a port reproduces the
 * file byte for byte, cores and signatures alike.
 */
import type { Change, DocChange, PeerId, SyncEvent } from "@syncmesh/kernel";

import {
  type CellValue,
  GENESIS_RULE,
  SETTLED_RULE,
  eventId,
  hlcOf,
  parseActionId,
  parseLineageId,
  parseSeqNum,
  type ColumnName,
  type PartitionKey,
  type Procedure,
} from "@syncmesh/kernel";
import {
  bytesToHex,
  createIdentity,
  deriveLineage,
  docChangeId,
  signCheckpoint,
  signEvent,
} from "@syncmesh/wire";

import { CONTENT, LORO, N1, NOTES, T0 } from "./doc-names.js";
import { lineageCellVectors } from "./lineage-cells.js";
import { lineageTreeVectors } from "./lineage-trees.js";
import { wireVectors } from "./vectors.js";

const AUTHOR_SEED = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
const PRODUCER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixed vector names; the rules for these brands live in the schema */
const TITLE = "title" as ColumnName;
const WORD_COUNT = "wordCount" as ColumnName;
const PARTITION = "workspace:w1" as PartitionKey;
const procedure = (name: string) => name as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const ACTION = parseActionId("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf").unwrap();
const UNDONE = parseActionId("b0b1b2b3b4b5b6b7b8b9babbbcbdbebf").unwrap();

const seq = (n: number) => parseSeqNum(n).unwrap();

const doc = (extra: Partial<DocChange> = {}): DocChange => ({
  kind: "doc",
  table: NOTES,
  key: N1,
  column: CONTENT,
  adapter: LORO,
  update: { bytes: Uint8Array.of(0x6c, 0x6f, 0x72, 0x6f) },
  ...extra,
});

/** An event of `author` at sequence `n`, stamped `T0 + n`. */
type At = (n: number, extra: Partial<SyncEvent>, changes: readonly Change[]) => SyncEvent;

/**
 * Geneses of the rule this build writes (gaps U39): 3 in key 5, with no anchor and with one.
 * The geneses before them were written under rules 1 and 2 and stay frozen as old logs hold them.
 */
const ruleThreeEvents = (author: PeerId, at: At): readonly (readonly [string, SyncEvent])[] => [
  [
    "a genesis of rule 3 that replaces the seq-7 lineage: 3 in key 5, no anchor (gaps U39)",
    at(8, { procedure: procedure("notes.replace") }, [
      doc({
        lineage: deriveLineage(author, seq(8), 0),
        genesis: true,
        parent: deriveLineage(author, seq(7), 0),
        update: { bytes: Uint8Array.of(10, 11) },
      }),
    ]),
  ],
  [
    "a genesis of rule 3 that settles the walk at the seq-6 lineage: 3 in key 5, its anchor in key 7 (gaps U39)",
    at(9, { procedure: procedure("notes.replace") }, [
      doc({
        lineage: deriveLineage(author, seq(9), 0),
        genesis: true,
        parent: deriveLineage(author, seq(8), 0),
        settles: {
          lineage: deriveLineage(author, seq(6), 0),
          stamp: { hlc: hlcOf(T0 + 6, 0), peer: author },
        },
        update: { bytes: Uint8Array.of(12, 13) },
      }),
    ]),
  ],
];

export function docVectors() {
  const author = createIdentity(AUTHOR_SEED).unwrap();
  const producer = createIdentity(PRODUCER_SEED).unwrap();

  const at: At = (n, extra, changes) => ({
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
      "an insert and a genesis of rule 1 in one event: the lineage derives from change index 1",
      at(3, { procedure: procedure("notes.replace") }, [
        { kind: "insert", table: NOTES, key: N1, row: new Map([[CONTENT, null]]) },
        doc({
          lineage: genesisLineage,
          genesis: true,
          rule: GENESIS_RULE,
          update: { bytes: Uint8Array.of(1, 2, 3) },
        }),
      ]),
    ],
    ["an update in an action", at(4, { action: ACTION }, [doc()])],
    [
      "the undo of that action, in an action of its own",
      at(5, { action: UNDONE, undoOf: ACTION, procedure: procedure("revert") }, [doc()]),
    ],
    [
      "a genesis of rule 1 that replaces the seq-3 lineage: its parent in key 6 (RFC-0023 §16.1)",
      at(6, { procedure: procedure("notes.replace") }, [
        doc({
          lineage: deriveLineage(author.peerId, seq(6), 0),
          genesis: true,
          rule: GENESIS_RULE,
          parent: genesisLineage,
          update: { bytes: Uint8Array.of(4, 5, 6) },
        }),
      ]),
    ],
    [
      "a genesis of rule 2 that settles the walk at the seq-3 lineage: its anchor in key 7 (gaps U21)",
      at(7, { procedure: procedure("notes.replace") }, [
        doc({
          lineage: deriveLineage(author.peerId, seq(7), 0),
          genesis: true,
          rule: SETTLED_RULE,
          parent: deriveLineage(author.peerId, seq(6), 0),
          settles: {
            lineage: genesisLineage,
            stamp: { hlc: hlcOf(T0 + 3, 0), peer: author.peerId },
          },
          update: { bytes: Uint8Array.of(7, 8, 9) },
        }),
      ]),
    ],
    ...ruleThreeEvents(author.peerId, at),
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

  const lineageTrees = lineageTreeVectors(author.peerId, producer.peerId);
  const lineageCells = lineageCellVectors(author.peerId, producer.peerId);

  const frozen = wireVectors.vectors[0];
  return {
    authorId: author.peerId,
    producerId: producer.peerId,
    events: events.map(([description, event]) => {
      const signed = signEvent(event, author);
      return { description, coreHex: bytesToHex(signed.core), sigHex: bytesToHex(signed.sig) };
    }),
    lineages,
    lineageTrees,
    lineageCells,
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
