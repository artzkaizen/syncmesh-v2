/**
 * Regenerates conformance/feed-vectors.json from a fixed seed. Run only when the feed chain or
 * its certificate deliberately changes (README rule 3): `bun conformance/src/generate-feed-vectors.ts`.
 *
 * One signature per run instead of per event (RFC-0019): `head(n) = sha256(head(n-1) ‖ core(n))`
 * from a zero genesis, and the author signs `[v, peerId, seq, head]`. A port that walks these
 * three cores to this head, and whose certificate core is these bytes, verifies a run the same way.
 */
import type { ColumnName, Procedure, RowKey, SyncEvent, TableName } from "@syncmesh/kernel";

import { eventId, hlcOf, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import {
  GENESIS,
  advanceFeed,
  bytesToHex,
  certifyFeed,
  chunkFrom,
  createIdentity,
  encodeEventCore,
  feedCertificateCore,
  type FeedHead,
} from "@syncmesh/wire";

const DEVICE_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 + i);
const T0 = 1_700_000_000_000;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures: documented literals for branded names */
const NOTES = "notes" as TableName;
const N1 = "n1" as RowKey;
const TITLE = "title" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** The author's first three events: create, update, delete of one note, a millisecond apart. */
function feedEvents(): readonly SyncEvent[] {
  const device = createIdentity(DEVICE_SEED).unwrap();
  const peerId = parsePeerId(device.peerId).unwrap();
  const at = (seq: number, procedure: string, change: SyncEvent["changes"][number]): SyncEvent => {
    const seqNum = parseSeqNum(seq).unwrap();
    return {
      v: 1,
      id: eventId(peerId, seqNum),
      peerId,
      seqNum,
      hlc: hlcOf(T0 + seq, 0),
      // SAFETY: a procedure is a branded string; these are documented literals
      procedure: procedure as Procedure,
      changes: [change],
    };
  };
  return [
    at(1, "notes.create", {
      kind: "insert",
      table: NOTES,
      key: N1,
      row: new Map([[TITLE, "hello"]]),
    }),
    at(2, "notes.update", {
      kind: "update",
      table: NOTES,
      key: N1,
      patch: new Map([[TITLE, "hëllo"]]),
    }),
    at(3, "notes.delete", { kind: "delete", table: NOTES, key: N1 }),
  ];
}

export function feedVectors() {
  const device = createIdentity(DEVICE_SEED).unwrap();
  const cores = feedEvents().map((event) => encodeEventCore(event));
  const heads: FeedHead[] = [];
  let head = GENESIS;
  for (const core of cores) {
    head = advanceFeed(head, core);
    heads.push(head);
  }
  const certificate = certifyFeed(device, head);
  const fromGenesis = chunkFrom(device, GENESIS, cores);
  const fromOne = chunkFrom(device, heads[0] ?? GENESIS, cores.slice(1));
  return {
    peerId: device.peerId,
    genesisHashHex: bytesToHex(GENESIS.hash),
    chain:
      "head(n) = sha256(head(n-1) ‖ core(n)); certificate core = cbor {0: 1, 1: peerId bytes, 2: seq, 3: head}",
    events: cores.map((core, i) => ({
      seq: i + 1,
      coreHex: bytesToHex(core),
      headHex: bytesToHex(heads[i]?.hash ?? new Uint8Array()),
    })),
    certificate: {
      seq: Number(certificate.head.seq),
      coreHex: bytesToHex(feedCertificateCore(device.peerId, certificate.head)),
      sigHex: bytesToHex(certificate.sig),
    },
    /** Two runs under the one certificate: the whole feed, and the tail a receiver at seq 1 asks for. */
    chunks: [
      {
        description: "from genesis",
        from: Number(fromGenesis.from),
        cores: fromGenesis.cores.length,
      },
      { description: "from seq 1", from: Number(fromOne.from), cores: fromOne.cores.length },
    ],
  };
}

if (import.meta.main) {
  const out = new URL("../feed-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(feedVectors(), null, 2)}\n`);
}
