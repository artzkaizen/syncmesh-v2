import type { PeerId } from "@syncmesh/kernel";

import { bytesToHex, hexToBytes } from "@syncmesh/wire";

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

export const hintOf = (peer: PeerId): string => String(peer).slice(0, HINT_CHARS);

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
export const advertisement = (peer: PeerId, serviceUuid: string) => ({
  serviceUuids: [serviceUuid],
  localName: hintOf(peer),
  serviceDataBase64: { [serviceUuid]: bytesToBase64(hexToBytes(hintOf(peer)).unwrap()) },
});

/** The hint a scan result carries, from whichever field arrived; `undefined` for anyone else's. */
export const hintFrom = (
  advert: {
    readonly localName?: string | undefined;
    readonly serviceDataBase64?: Readonly<Record<string, string>> | undefined;
  },
  serviceUuid: string,
): string | undefined => {
  const name = advert.localName;
  if (name !== undefined && isHint(name)) return name;
  const data = advert.serviceDataBase64?.[serviceUuid];
  if (data === undefined) return undefined;
  const bytes = base64ToBytes(data);
  if (bytes.isErr()) return undefined;
  const hint = bytesToHex(bytes.value);
  return isHint(hint) ? hint : undefined;
};

const HEX = /^[0-9a-f]+$/;
const isHint = (value: string): boolean => value.length === HINT_CHARS && HEX.test(value);
