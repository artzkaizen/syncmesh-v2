import type { PeerId } from "@syncmesh/kernel";

import { bytesToHex, hexToBytes } from "@syncmesh/wire";

import type { BleAdvertisement } from "./radio.js";

import { base64ToBytes, bytesToBase64 } from "./base64.js";

/**
 * How a device says who it is before anyone has connected.
 *
 * **A peer id does not fit in an advertisement.** The whole payload is 31 bytes; the flags take
 * three and a 128-bit service UUID takes eighteen, which leaves ten for everything else — and a
 * peer id is 64 hex characters. So what travels is a *hint*: the first bytes of the id, which is
 * already a public key and therefore uniformly distributed, so a short prefix separates devices
 * as well as a hash of one would and costs nothing to compute or check.
 *
 * The hint is for two jobs and no others: telling one device from another during a scan, and
 * deciding which end dials. **Identity is never established here.** The bridge does that with
 * grants and signatures once a link exists, exactly as it does on every other transport, so a
 * hint that lies gets a session that goes nowhere rather than a peer that is believed.
 */

/** Four bytes of the peer id, as hex. Enough to separate the devices in a room, and it fits. */
export const HINT_CHARS = 8;

export const hintOf = (peer: PeerId): string => peer.slice(0, HINT_CHARS);

/**
 * The advertisement, in both places it can travel.
 *
 * The local name and the service data carry the same hint because the platforms disagree about
 * which survives: iOS does not surface service data from every advertiser, and Android's local
 * name is not always present in a scan result. Writing both and reading either is cheaper than
 * being wrong about which platform is on the other side.
 *
 * **The budget is why the name carries no marker of its own.** Flags take three bytes and the
 * service UUID eighteen, leaving ten — and a name costs two of those for its header. Eight hex
 * characters is exactly what remains. A prefix saying "this one is ours" would not fit, and
 * would say nothing anyway: the scan filters on the service UUID, so everything it reports is
 * already advertising this service. The service data travels in the scan response, which is a
 * second payload the platform fills in and one more reason to read whichever field arrives.
 */
export const advertisement = (peer: PeerId, serviceUuid: string, group?: string) => ({
  serviceUuids: [serviceUuid],
  localName: hintOf(peer),
  serviceDataBase64: {
    [serviceUuid]: bytesToBase64(
      group === undefined
        ? hexToBytes(hintOf(peer)).unwrap()
        : Uint8Array.from([...hexToBytes(hintOf(peer)).unwrap(), ...groupTag(group)]),
    ),
  },
});

/** Four bytes of group, after the four bytes of hint — the scan response has nine to spare. */
export const GROUP_TAG_BYTES = 4;

/**
 * Which fleet an advertisement belongs to, in four bytes.
 *
 * **This is the only question a BLE advertisement has room to answer usefully.** It cannot name
 * a peer — a peer id is 64 hex characters and there are ten bytes — and a four-byte *prefix* of
 * one cannot be refused on, because a device with no grant yet must stay dialable: that is the
 * join corridor, and from a prefix you cannot tell "another company's phone" from "one of ours,
 * about to ask for a grant". A group can be refused on, because a device of ours carries the
 * group from config before it carries any credential.
 *
 * Not a digest, and it does not need to be: `group` is already documented as an optimization and
 * not a security control — anyone can put any four bytes in the air. A collision costs one dial.
 */
export const groupTag = (group: string): Uint8Array => {
  // FNV-1a, 32-bit: small, dependency-free, and well spread over short names
  let hash = 0x81_1c_9d_c5;
  for (const unit of new TextEncoder().encode(group)) {
    hash ^= unit;
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return Uint8Array.from([hash >>> 24, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff]);
};

/**
 * The group an advertisement carries, or `undefined` when it carries none — which is what an
 * older build advertises, and what a platform that surfaced only the local name leaves us with.
 *
 * Absent means **abstain, not refuse**. A device we cannot place is one we dial and let the
 * handshake settle, exactly as before; refusing on a field that may simply not have arrived
 * would make a working fleet invisible to itself on whichever platform drops service data.
 */
export const groupFrom = (
  advert: Pick<BleAdvertisement, "serviceDataBase64">,
  serviceUuid: string,
): Uint8Array | undefined => {
  const data = advert.serviceDataBase64?.[serviceUuid];
  if (data === undefined) return undefined;
  const bytes = base64ToBytes(data);
  if (bytes.isErr() || bytes.value.length < HINT_CHARS / 2 + GROUP_TAG_BYTES) return undefined;
  return bytes.value.subarray(HINT_CHARS / 2, HINT_CHARS / 2 + GROUP_TAG_BYTES);
};

/** The hint a scan result carries, from whichever field arrived; `undefined` for anyone else's. */
export const hintFrom = (
  advert: Pick<BleAdvertisement, "localName" | "serviceDataBase64">,
  serviceUuid: string,
): string | undefined => {
  const name = advert.localName;
  if (name !== undefined && isHint(name)) return name;
  const data = advert.serviceDataBase64?.[serviceUuid];
  if (data === undefined) return undefined;
  const bytes = base64ToBytes(data);
  if (bytes.isErr()) return undefined;
  // a newer build appends its group after the hint; read the hint and leave the rest alone
  const hint = bytesToHex(bytes.value.subarray(0, HINT_CHARS / 2));
  return isHint(hint) ? hint : undefined;
};

const HEX = /^[0-9a-f]+$/;
const isHint = (value: string): boolean => value.length === HINT_CHARS && HEX.test(value);
