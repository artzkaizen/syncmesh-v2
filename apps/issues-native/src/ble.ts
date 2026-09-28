import type { BleSighting } from "@syncmesh/ble";
import type { Transport } from "@syncmesh/transport";

import { bleTransport } from "@syncmesh/ble";
import { nativeRadio } from "@syncmesh/react-native/ble";
import Constants from "expo-constants";

/**
 * The mesh over the air, with no relay in the middle and no network at all.
 *
 * This is the transport the rest of the system exists to make possible, and the one that makes the
 * claim testable: two phones in a room, aeroplane mode on both, and a write on one appearing on
 * the other. Everything above it is unchanged — the same engine, the same fold, the same
 * `(author, seq)` cursor exchange — because a medium is a plugin here rather than a fork
 * (book ch. 15). What BLE contributes is the hardest case: a few slow links, a small MTU, and
 * peers that appear and vanish while a transfer is in flight.
 *
 * **What is left in this file is only what is this app's.** Finding the native module, tracking
 * what the adapter says, and reporting why there is no radio are the platform's problems and every
 * React Native app built on syncmesh has them; they live in `@syncmesh/react-native/ble` now. The
 * four identifiers below are not shared with anybody: they are who *this* app answers to on the
 * air, and a library that shipped them would be deciding which strangers' phones talk to which.
 */

/**
 * **The service and characteristic are the convention both ends agree on.** They are not secret
 * and not a credential: a stranger's phone can find this service, connect to it, and get exactly
 * as far as the handshake before its events are quarantined for want of a grant.
 */
const SERVICE = "19d74c40-95d0-4b3c-a4a3-d4a8c8bdfe01";
const CHARACTERISTIC = "19d74c41-95d0-4b3c-a4a3-d4a8c8bdfe01";

/**
 * The four bytes a phone puts in the air before it has said anything else.
 *
 * An advertisement has ten bytes to spend and a peer id does not fit in them, so this is the only
 * refusal BLE can make cheaply: a device not carrying this group is dropped before a connection,
 * a subscription and a handshake are spent on it. **An optimization, not a security control** —
 * anyone can broadcast any four bytes, and everything that reaches a link still faces the grant
 * and the `allow` rules.
 */
const GROUP = "acme";

/**
 * The radio's own word about itself, passed straight through to the screen that shows it.
 *
 * Re-exported rather than read directly by `app/settings.tsx` because this file is where the app
 * decides it has a radio at all: a screen that imported the library for one reading and this file
 * for the rest would be holding two halves of one answer.
 */
export { radioAbsence, radioState, type NoRadio } from "@syncmesh/react-native/ble";

/**
 * BLE, if this build has the native module and the platform will give it a radio.
 *
 * `extra.bluetooth` in `app.json` is this app's switch for building without one — a simulator
 * build, or a run where the radio is just noise. Absent, it is on.
 */
export const bleOverAir = (
  onDropped: (why: string) => void,
  onSighting: (sighting: BleSighting) => void,
): Transport | undefined => {
  const radio = nativeRadio({ enabled: Constants.expoConfig?.extra?.bluetooth !== false });
  if (radio === undefined) return undefined;
  return bleTransport({
    characteristicUuid: CHARACTERISTIC,
    group: GROUP,
    // a phone's controller sustains a handful of links; asking for more gives you more links that
    // all work worse rather than more capacity
    maxLinks: 4,
    name: "issues",
    onDropped,
    // what the radio saw and what it decided — see `./link-log.ts`. Without it, a fleet that
    // finds nobody and a fleet that finds everybody and dials nobody log exactly the same nothing
    onSighting,
    radio,
    serviceUuid: SERVICE,
  });
};
