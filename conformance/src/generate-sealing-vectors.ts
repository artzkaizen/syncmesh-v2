/**
 * Regenerates conformance/sealing-vectors.json from fixed keys and nonces. Run only when sealing
 * deliberately changes (README rule 3): `bun conformance/src/generate-sealing-vectors.ts`.
 *
 * A sealed partition's content travels as `[u16 epoch][24-byte nonce][XChaCha20-Poly1305 body]`
 * under the partition's content key, bound to `cbor [peerId bytes, seq, partition]` as the
 * associated data (book ch. 14); the event core then carries it under key 8 instead of the
 * plaintext changes under key 7. A content key reaches one device as
 * `[32-byte X25519 ephemeral public][24-byte nonce][body]` under HKDF-SHA256(shared, info =
 * device id bytes). Every input is printed so a port can reproduce every output.
 */
import type { ColumnName, Procedure, RowKey, SyncEvent, TableName } from "@syncmesh/kernel";

import { eventId, hlcOf, parsePartitionKey, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import {
  FIRST_EPOCH,
  bytesToHex,
  createIdentity,
  encodeCbor,
  encodeEventCore,
  hexToBytes,
  sealPayload,
  wrapKey,
} from "@syncmesh/wire";

const DEVICE_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 + i);
const KEY = Uint8Array.from({ length: 32 }, (_, i) => 0x30 + i);
const NONCE = Uint8Array.from({ length: 24 }, (_, i) => 0x50 + i);
const EPHEMERAL = Uint8Array.from({ length: 32 }, (_, i) => 0x60 + i);
const WRAP_NONCE = Uint8Array.from({ length: 24 }, (_, i) => 0x70 + i);
const ACME = parsePartitionKey("org:acme").unwrap();
const T0 = 1_700_000_000_000;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures: documented literals for branded names */
const NOTES = "notes" as TableName;
const N1 = "n1" as RowKey;
const TITLE = "title" as ColumnName;
const CREATE = "notes.create" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export function sealingVectors() {
  const device = createIdentity(DEVICE_SEED).unwrap();
  const peerId = parsePeerId(device.peerId).unwrap();
  const seqNum = parseSeqNum(1).unwrap();
  const event: SyncEvent = {
    v: 1,
    id: eventId(peerId, seqNum),
    peerId,
    seqNum,
    hlc: hlcOf(T0 + 1, 0),
    procedure: CREATE,
    partition: ACME,
    changes: [{ kind: "insert", table: NOTES, key: N1, row: new Map([[TITLE, "hello"]]) }],
  };
  let plain: Uint8Array | undefined;
  let aad: Uint8Array | undefined;
  const sealedCore = encodeEventCore(event, {
    seal: (_partition, plainChanges, associated) => {
      plain = plainChanges;
      aad = associated;
      return sealPayload(KEY, plainChanges, associated, FIRST_EPOCH, NONCE);
    },
  });
  if (plain === undefined || aad === undefined) throw new Error("the codec did not seal");
  const expectedAad = encodeCbor([hexToBytes(device.peerId).unwrap(), 1, String(ACME)]);
  if (bytesToHex(aad) !== bytesToHex(expectedAad))
    throw new Error("the aad is not [peer, seq, partition]");
  return {
    context: {
      payload: "[u16 epoch][24-byte nonce][xchacha20poly1305(key, nonce, aad).encrypt(plain)]",
      aad: "cbor [peerId bytes, seq, partition]",
      wrap: "[x25519 ephemeral public][24-byte nonce][xchacha20poly1305(hkdf-sha256(shared, salt none, info = device id bytes, 32), nonce).encrypt(key)]; shared = x25519(ephemeral, toMontgomery(device ed25519 key))",
    },
    deviceId: device.peerId,
    partition: String(ACME),
    keyHex: bytesToHex(KEY),
    epoch: FIRST_EPOCH,
    nonceHex: bytesToHex(NONCE),
    aadHex: bytesToHex(aad),
    plainHex: bytesToHex(plain),
    sealedHex: bytesToHex(sealPayload(KEY, plain, aad, FIRST_EPOCH, NONCE)),
    plainCoreHex: bytesToHex(encodeEventCore(event)),
    sealedCoreHex: bytesToHex(sealedCore),
    wrap: {
      ephemeralSecretHex: bytesToHex(EPHEMERAL),
      nonceHex: bytesToHex(WRAP_NONCE),
      wrappedHex: bytesToHex(wrapKey(device.peerId, KEY, EPHEMERAL, WRAP_NONCE)),
    },
  };
}

if (import.meta.main) {
  const out = new URL("../sealing-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(sealingVectors(), null, 2)}\n`);
}
