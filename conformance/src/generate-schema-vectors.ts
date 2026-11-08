/**
 * Regenerates conformance/schema-vectors.json from fixed seeds. Run only when D31's wire
 * deliberately changes (README rule 3): `bun conformance/src/generate-schema-vectors.ts`.
 *
 * D31's three wire facts, frozen together because they are one decision:
 *
 * - **events**: `schemaVersion` under event core key 9. An event from a build that declares none
 *   carries no key 9 and is the bytes it always was (`wire-vectors.json`). A key 9 that is not a
 *   positive integer reads as no version and is never a reason to refuse the event: a build from
 *   before D31 skips the key whatever it holds, and a reading must not split the two builds.
 * - **frames**: the cursors frame with the sender's version at index 5, after `ahead` at 3 and
 *   D46's compaction floor at 4, both sent (empty when there is nothing to say) so an older
 *   build's strict read of index 3 still holds. An index 5 that is not a positive integer reads
 *   as no version.
 * - **refusals**: a write to a table this build dropped parks under a bucket of its own,
 *   `dropped-table`, which never leaves the device. The receipt says `refused`, verdict
 *   `TableDropped`: an older build's `verifyRefusal` drops a reason it cannot name.
 */
import type { ColumnName, PeerId, Procedure, RowKey, SyncEvent, TableName } from "@syncmesh/kernel";

import {
  eventId,
  hlcOf,
  parsePeerId,
  parseSchemaVersion,
  parseSeqNum,
  type SeqNum,
} from "@syncmesh/kernel";
import { cursorsFrame } from "@syncmesh/transport";
import {
  bytesToHex,
  createIdentity,
  decodeCbor,
  encodeCbor,
  encodeEventCore,
  issueRefusal,
  type CborKey,
  type CborValue,
} from "@syncmesh/wire";

import { AUTHOR_SEED, HOLDER_SEED, NOW } from "./generate-receipt-vectors.js";

const DEVICE_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 + i);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 121 + i);
const T0 = 1_700_000_000_000;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures: documented literals for branded names */
const NOTES = "notes" as TableName;
const N1 = "n1" as RowKey;
const TITLE = "title" as ColumnName;
const CREATE = "notes.create" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** One author's event, stamped with `schemaVersion` when one is given. */
function event(peerId: PeerId, schemaVersion: number | undefined): SyncEvent {
  const seqNum = parseSeqNum(1).unwrap();
  const base: SyncEvent = {
    v: 1,
    id: eventId(peerId, seqNum),
    peerId,
    seqNum,
    hlc: hlcOf(T0, 0),
    procedure: CREATE,
    changes: [{ kind: "insert", table: NOTES, key: N1, row: new Map([[TITLE, "hello"]]) }],
  };
  return schemaVersion === undefined
    ? base
    : { ...base, schemaVersion: parseSchemaVersion(schemaVersion).unwrap() };
}

/** The core with key 9 replaced by `value`: what a build that wrote something odd there sends. */
function withKey9(core: Uint8Array, value: CborValue): Uint8Array {
  const map = decodeCbor(core).unwrap();
  if (!(map instanceof Map)) throw new Error("fixture: a core is a map");
  const edited = new Map<CborKey, CborValue>(map);
  edited.set(9, value);
  return encodeCbor(edited);
}

function eventCases() {
  const device = createIdentity(DEVICE_SEED).unwrap();
  const peerId = parsePeerId(device.peerId).unwrap();
  const stamped = encodeEventCore(event(peerId, 3));
  const cases = [
    {
      description: "notes.create written under schemaVersion 3",
      core: stamped,
      schemaVersion: 3,
      reencodes: true,
    },
    {
      description:
        "notes.create written under schemaVersion 1, which is still written when declared",
      core: encodeEventCore(event(peerId, 1)),
      schemaVersion: 1,
      reencodes: true,
    },
    {
      description: "key 9 holding text reads as no version, and the event still decodes",
      core: withKey9(stamped, "three"),
      schemaVersion: null,
      reencodes: false,
    },
    {
      description: "key 9 holding 0 reads as no version: a version is a positive integer",
      core: withKey9(stamped, 0),
      schemaVersion: null,
      reencodes: false,
    },
  ];
  return {
    peerId: device.peerId,
    events: cases.map(({ description, core, schemaVersion, reencodes }) => ({
      description,
      coreHex: bytesToHex(core),
      sigHex: bytesToHex(device.sign(core)),
      schemaVersion,
      reencodes,
    })),
  };
}

function frameCases() {
  const device = createIdentity(DEVICE_SEED).unwrap();
  const other = createIdentity(OTHER_SEED).unwrap();
  /* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- sequences are branded integers; documented literals */
  const cursors = new Map<PeerId, SeqNum>([
    [device.peerId, 7 as SeqNum],
    [other.peerId, 3 as SeqNum],
  ]);
  const ahead = new Map<PeerId, readonly SeqNum[]>([[other.peerId, [5 as SeqNum, 6 as SeqNum]]]);
  /* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
  const four = parseSchemaVersion(4).unwrap();
  const versioned = cursorsFrame(device.peerId, cursors, ahead, four);
  const outer = decodeCbor(versioned).unwrap();
  if (!Array.isArray(outer)) throw new Error("fixture: a frame is an array");
  const odd = encodeCbor([...outer.slice(0, 5), "four"]);
  return [
    {
      description: "cursors with what is held above them and schemaVersion 4 at index 5",
      wireHex: bytesToHex(versioned),
      schemaVersion: 4,
      ahead: true,
    },
    {
      description: "cursors with schemaVersion 4 and nothing ahead: ahead and the floor go empty",
      wireHex: bytesToHex(cursorsFrame(device.peerId, cursors, undefined, four)),
      schemaVersion: 4,
      ahead: false,
    },
    {
      description: "an index 5 that is not a positive integer reads as no version",
      wireHex: bytesToHex(odd),
      schemaVersion: null,
      ahead: true,
    },
  ];
}

function refusalCases() {
  const refuser = createIdentity(HOLDER_SEED).unwrap();
  const author = createIdentity(AUTHOR_SEED).unwrap();
  return [
    {
      description: "a newer build that dropped the table: refused, with the verdict that says so",
      seq: 9,
      reason: "refused",
      verdict: "TableDropped",
      wireHex: bytesToHex(
        issueRefusal(refuser, {
          author: author.peerId,
          seq: parseSeqNum(9).unwrap(),
          reason: "refused",
          verdict: "TableDropped",
          now: NOW,
        }),
      ),
    },
  ];
}

export function schemaVectors() {
  const { peerId, events } = eventCases();
  return {
    peerId,
    refuserId: createIdentity(HOLDER_SEED).unwrap().peerId,
    authorId: createIdentity(AUTHOR_SEED).unwrap().peerId,
    events,
    frames: frameCases(),
    refusals: refusalCases(),
  };
}

if (import.meta.main) {
  const out = new URL("../schema-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(schemaVectors(), null, 2)}\n`);
}
