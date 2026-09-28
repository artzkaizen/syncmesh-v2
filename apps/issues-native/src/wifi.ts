import type { Transport } from "@syncmesh/transport";

import { nativeLan } from "@syncmesh/react-native/lan";
import { nativeFabric } from "@syncmesh/react-native/p2p";
import { awdl, lan, wifiAware } from "@syncmesh/transports";
import Constants from "expo-constants";

/**
 * The fast lane over the air: the same mesh, two orders of magnitude more bandwidth than BLE.
 *
 * BLE stays underneath this and is not replaced by it. It is the only medium here with background
 * execution, the only one that works iPhone-to-iPhone with no network *and* no pairing, and the
 * only one that reaches an Android phone — where these two do not: AWDL is Apple's own, and
 * Apple's Wi-Fi Aware and Android's have never been shown to move a byte between them. So this is
 * an opportunistic bulk lane for two foregrounded apps in a room, and the route scorer decides
 * per frame which of the three carries what, from the bandwidth each declares.
 *
 * **Two transports and not one**, because AWDL and Wi-Fi Aware never interoperate: an iPhone on
 * one and a phone on the other are two rooms, and a merged `p2pWifi` would hide exactly the fact
 * a mixed fleet has to be able to read. A device that has neither simply has fewer sources.
 */

/**
 * The room. Everything that names this string finds everything else that does, and nothing else.
 *
 * Deliberately the app's, not the library's — the same decision as the service uuid in `./ble.ts`.
 * It travels in the Bonjour TXT record rather than in the service type, because iOS will only
 * browse a type declared in `Info.plist` and that list takes no wildcard, so a type per room is a
 * type the system refuses to look for.
 */
const ROOM = "issues";

/** What a phone sustains before every path degrades. Four is the radio's number, not a preference. */
const MAX_LINKS = 4;

export interface OverWifi {
  readonly transports: readonly Transport[];
  /** Let go of the native module's listeners — see `BoundFabric.dispose`. */
  readonly release: () => void;
}

/**
 * Whichever peer-to-peer Wi-Fi radios this build and this device actually have.
 *
 * Returns an empty list rather than throwing: a simulator has no radio, an Expo Go client has no
 * native module, and an iPhone 11 has no Wi-Fi Aware. None of those is a broken app — the mesh
 * has fewer sources, `$status` says which and why, and every read is still answered out of this
 * device's own database.
 */
export const wifiOverAir = (onDropped: (why: string) => void): OverWifi => {
  const enabled = Constants.expoConfig?.extra?.wifiDirect !== false;
  const transports: Transport[] = [];
  const release: (() => void)[] = [];

  for (const [protocol, build] of [
    ["awdl", awdl],
    ["wifi-aware", wifiAware],
  ] as const) {
    const bound = nativeFabric(protocol, { enabled });
    if (bound === undefined) continue;
    release.push(bound.dispose);
    transports.push(
      build({
        fabric: bound.fabric,
        id: ROOM,
        maxLinks: MAX_LINKS,
        name: protocol === "awdl" ? "issues-awdl" : "issues-aware",
        onDropped,
      }),
    );
  }

  /**
   * And the local network, which is the only one of the three a mixed room meets on.
   *
   * It needs an access point the radios do not — but AWDL is Apple-to-Apple and Wi-Fi Aware has
   * never been shown to carry a byte between an iPhone and an Android phone, so when there *is* a
   * network this is the fast path that works for everybody, and it is the same transport the
   * relay speaks under Node.
   */
  const overLan = nativeLan({ enabled, onDropped });
  if (overLan !== undefined) {
    release.push(overLan.dispose);
    transports.push(lan({ id: ROOM, name: "issues-lan", network: overLan.network, onDropped }));
  }

  return { release: () => release.forEach((let_go) => let_go()), transports };
};
