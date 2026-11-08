/**
 * Regenerates conformance/relay-vectors.json. Run only when a relay control frame deliberately
 * changes (README rule 3): `bun conformance/src/generate-relay-vectors.ts`.
 *
 * D14's tag space above the session frames, tag by tag. A vector is only ever appended: the Rust
 * check in crates/syncmesh-core/tests/frame_vectors.rs reads them by index. The join with a proof comes from the
 * join vectors, so the two files can never disagree about what a v2 join is.
 */
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { scopeText } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import {
  REGRANTED,
  REGRANTED_MESSAGE,
  RELAY_PROTOCOL_VERSIONS,
  REVOKED,
  REVOKED_MESSAGE,
  UNGRANTED,
  UNGRANTED_MESSAGE,
  ackFrame,
  blobFrame,
  blobGetFrame,
  blobMissingFrame,
  blobPutFrame,
  blobRefusedFrame,
  blobStoredFrame,
  challengeFrame,
  errorFrame,
  helloFrame,
  joinFrame,
  kaFrame,
  pageFrame,
  relayedFrame,
} from "@syncmesh/relay";
import { bytesToHex } from "@syncmesh/wire";

import { joinVectors } from "./generate-join-vectors.js";
import { roomRefusalVectors } from "./generate-refusal-vectors.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures: a 32-byte hex name stands in for a peer, sequences are branded integers */
const PEER = bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i)) as PeerId;
const CURSORS = new Map([[PEER, 7 as SeqNum]]);
const FLOOR = new Map([[PEER, 4 as SeqNum]]);
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const ACME = parsePartitionKey("org:acme").unwrap();
const GRANT = Uint8Array.of(0xa1, 0xb2, 0xc3);
const EVENT = Uint8Array.of(0x01, 0x02, 0x03, 0x04);
const BYTES = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
const HASH = "b3:0102";
const NONCE = Uint8Array.from({ length: 32 }, (_, i) => i);

/** One frozen control frame: what it shows, its kind and tag, and its bytes. */
interface RelayVector {
  readonly description: string;
  readonly kind: string;
  readonly tag: number;
  readonly wireHex: string;
}

/** D40's grant-gated room: its three typed refusals, and the live notice of an event passed over. */
const grantGateVectors = () => [
  {
    description:
      "error, the typed gate refusal: a gated room holds no grant from an issuer it trusts for this key (D40)",
    kind: "error",
    tag: 10,
    wireHex: bytesToHex(errorFrame(UNGRANTED, UNGRANTED_MESSAGE)),
  },
  {
    description:
      "error, a newer grant narrowed what this socket may read, or its grant lapsed: re-join (D40)",
    kind: "error",
    tag: 10,
    wireHex: bytesToHex(errorFrame(REVOKED, REVOKED_MESSAGE)),
  },
  {
    description: "error, a newer grant widened what this socket may read: re-join (D40)",
    kind: "error",
    tag: 10,
    wireHex: bytesToHex(errorFrame(REGRANTED, REGRANTED_MESSAGE)),
  },
  {
    description:
      "page, empty and last, carrying only a scoped coverage: live fan-out passed an event over, and the author's run is held up to it (D23, D40)",
    kind: "page",
    tag: 13,
    wireHex: bytesToHex(
      pageFrame([], [], false, 9, {
        synced: CURSORS,
        local: new Map(),
        scope: '{"partitions":["org:acme"]}',
      }),
    ),
  },
];

/** D18's per-partition quota: a put billed to a partition, and the two answers to a put. */
const blobQuotaVectors = () => [
  {
    description:
      "blob-put billed to a partition: one additive element, which a relay built before quotas reads past (D18)",
    kind: "blob-put",
    tag: 15,
    wireHex: bytesToHex(blobPutFrame(HASH, BYTES, ACME)),
  },
  {
    description: "blob-stored, the relay kept a put: the author may stop being the only holder",
    kind: "blob-stored",
    tag: 20,
    wireHex: bytesToHex(blobStoredFrame(HASH)),
  },
  {
    description: "blob-refused, a partition's quota: limit and spend, nothing stored (D18)",
    kind: "blob-refused",
    tag: 21,
    wireHex: bytesToHex(blobRefusedFrame(HASH, "quota", 1024, 1000, ACME)),
  },
  {
    description: "blob-refused, the budget of puts that named no partition",
    kind: "blob-refused",
    tag: 21,
    wireHex: bytesToHex(blobRefusedFrame(HASH, "quota", 1024, 1000)),
  },
];

export function relayVectors() {
  const signed = joinVectors();
  const cases: readonly RelayVector[] = [
    {
      description: "join, v1: one version, one cursor, no interest, no proof",
      kind: "join",
      tag: 8,
      wireHex: bytesToHex(joinFrame([1], PEER, CURSORS)),
    },
    {
      description: "join, v1: two versions offered, an interest in one partition",
      kind: "join",
      tag: 8,
      wireHex: bytesToHex(joinFrame([1, 2], PEER, CURSORS, { partitions: [ACME] })),
    },
    ...signed.vectors.map((v) => ({
      description: `join, v2: ${v.description} (proof in join-vectors.json)`,
      kind: "join",
      tag: 8,
      wireHex: v.joinHex,
    })),
    {
      description:
        "join, v3: on a sealed link, no proof — the hello that opened the link proved the key (D36); the link itself is handshake-vectors.json",
      kind: "join",
      tag: 8,
      wireHex: bytesToHex(joinFrame([3], PEER, CURSORS)),
    },
    {
      description: "hello, the selected version and an empty retention floor",
      kind: "hello",
      tag: 9,
      wireHex: bytesToHex(helloFrame(1, 15_000, "epoch-1", CURSORS)),
    },
    {
      description: "hello from a room that has trimmed its log",
      kind: "hello",
      tag: 9,
      wireHex: bytesToHex(helloFrame(1, 15_000, "epoch-1", CURSORS, FLOOR)),
    },
    {
      description: "error, the typed version refusal",
      kind: "error",
      tag: 10,
      wireHex: bytesToHex(errorFrame("version", "this relay speaks 2")),
    },
    {
      description: "error, the typed proof refusal (D33)",
      kind: "error",
      tag: 10,
      wireHex: bytesToHex(errorFrame("unproven", "the join was not signed by the key it names")),
    },
    {
      description: "error, the typed link refusal: a frame in the clear on a sealed link (D36)",
      kind: "error",
      tag: 10,
      wireHex: bytesToHex(errorFrame("handshake", "a frame in the clear on a sealed link")),
    },
    {
      description:
        "error, the typed seat refusal: a join naming a key the hello did not prove (D36)",
      kind: "error",
      tag: 10,
      wireHex: bytesToHex(
        errorFrame("impostor", "the join names a key other than the one that opened this link"),
      ),
    },
    { description: "ka", kind: "ka", tag: 11, wireHex: bytesToHex(kaFrame()) },
    { description: "ack", kind: "ack", tag: 12, wireHex: bytesToHex(ackFrame("evt-1", 3)) },
    {
      description: "page, grants on the first, more to come",
      kind: "page",
      tag: 13,
      wireHex: bytesToHex(pageFrame([GRANT], [EVENT], true, 9)),
    },
    {
      description: "page, the last one",
      kind: "page",
      tag: 13,
      wireHex: bytesToHex(pageFrame([], [EVENT], false, 9)),
    },
    {
      description: "relayed",
      kind: "relayed",
      tag: 14,
      wireHex: bytesToHex(relayedFrame(EVENT, 4)),
    },
    {
      description: "blob-put",
      kind: "blob-put",
      tag: 15,
      wireHex: bytesToHex(blobPutFrame(HASH, BYTES)),
    },
    { description: "blob-get", kind: "blob-get", tag: 16, wireHex: bytesToHex(blobGetFrame(HASH)) },
    { description: "blob", kind: "blob", tag: 17, wireHex: bytesToHex(blobFrame(HASH, BYTES)) },
    {
      description: "blob-missing",
      kind: "blob-missing",
      tag: 18,
      wireHex: bytesToHex(blobMissingFrame(HASH)),
    },
    {
      description:
        "challenge, a v2 room's first frame on a socket (D33); a v3 room sends a hello instead",
      kind: "challenge",
      tag: 19,
      wireHex: bytesToHex(challengeFrame(NONCE)),
    },
    {
      description:
        "page, the last of a gated catch-up: its coverage scoped to the interest and to the entitlement the relay admitted under (D24)",
      kind: "page",
      tag: 13,
      wireHex: bytesToHex(
        pageFrame([], [EVENT], false, 9, {
          synced: CURSORS,
          local: new Map(),
          scope: scopeText({ partitions: [ACME] }, "clinics:a"),
        }),
      ),
    },
    {
      description:
        "page, a pass-over: no events, the last, and a coverage for one author — the relay withheld what this device may not read and says how far it passed (D24)",
      kind: "page",
      tag: 13,
      wireHex: bytesToHex(
        pageFrame([], [], false, 12, {
          synced: CURSORS,
          local: new Map(),
          scope: scopeText(undefined, "clinics:a"),
        }),
      ),
    },
    ...blobQuotaVectors(),
    ...grantGateVectors(),
    ...roomRefusalVectors(),
  ];
  return { protocolVersions: [...RELAY_PROTOCOL_VERSIONS], vectors: cases };
}

if (import.meta.main) {
  const out = new URL("../relay-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(relayVectors(), null, 2)}\n`);
}
