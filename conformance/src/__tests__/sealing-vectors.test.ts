import { parsePeerId } from "@syncmesh/kernel";
import {
  bytesToHex,
  createIdentity,
  decodeEventCore,
  epochOf,
  hexToBytes,
  openPayload,
  sealPayload,
  unwrapKey,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../sealing-vectors.json" with { type: "json" };
import { sealingVectors } from "../generate-sealing-vectors.js";

const hex = (s: string) => hexToBytes(s).unwrap();
const KEY = hex(raw.keyHex);
const DEVICE_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 + i);

describe("sealing vectors — frozen (book ch. 14)", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(sealingVectors()))).toEqual(raw);
  });

  test("the payload is reproducible from key, nonce, aad and plaintext, and opens only under that key and aad", () => {
    expect(
      bytesToHex(
        sealPayload(KEY, hex(raw.plainHex), hex(raw.aadHex), raw.epoch, hex(raw.nonceHex)),
      ),
    ).toBe(raw.sealedHex);
    expect(epochOf(hex(raw.sealedHex))).toBe(raw.epoch);
    expect(bytesToHex(openPayload(KEY, hex(raw.sealedHex), hex(raw.aadHex)).unwrap())).toBe(
      raw.plainHex,
    );
    expect(
      openPayload(
        hex(raw.nonceHex + raw.nonceHex.slice(0, 16)),
        hex(raw.sealedHex),
        hex(raw.aadHex),
      ).isErr(),
    ).toBe(true);
    // lifted into another place: the same bytes under another author's aad do not open
    const elsewhere = Uint8Array.from(hex(raw.aadHex), (b, i) => (i === 3 ? b ^ 1 : b));
    expect(openPayload(KEY, hex(raw.sealedHex), elsewhere).isErr()).toBe(true);
  });

  test("a carrier reads the sealed core as an event with nothing readable; a key holder reads the changes", () => {
    const carried = decodeEventCore(hex(raw.sealedCoreHex)).unwrap();
    expect(carried.sealed).toBe(true);
    expect(carried.changes).toEqual([]);
    expect(String(carried.partition)).toBe(raw.partition);
    expect(String(carried.peerId)).toBe(raw.deviceId);
    const opened = decodeEventCore(hex(raw.sealedCoreHex), {
      open: (_partition, sealed, aad) => openPayload(KEY, sealed, aad).unwrapOr(undefined),
    }).unwrap();
    const plain = decodeEventCore(hex(raw.plainCoreHex)).unwrap();
    expect(opened.sealed).toBeUndefined();
    expect(opened.changes).toEqual(plain.changes);
  });

  test("the wrapped key opens for the device it was sealed to, and for nobody else", () => {
    const device = createIdentity(DEVICE_SEED).unwrap();
    expect(String(device.peerId)).toBe(raw.deviceId);
    expect(parsePeerId(raw.deviceId).isOk()).toBe(true);
    expect(bytesToHex(unwrapKey(device, hex(raw.wrap.wrappedHex)).unwrap())).toBe(raw.keyHex);
    const other = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 121 + i)).unwrap();
    expect(unwrapKey(other, hex(raw.wrap.wrappedHex)).isErr()).toBe(true);
  });
});
