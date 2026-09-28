/**
 * The adapters (book ch. 16, ch. 30): one import, one export per medium.
 *
 * One package rather than one per medium, because *which mediums exist* is a single fact about
 * this system and an app declaring two of them should not learn two package names to do it. What
 * stays separate is what is genuinely separate: each medium keeps its own port, so a device that
 * has a radio and no access point pulls in the radio's binding and not the network's.
 *
 * **`awdl` and `wifiAware` are two exports and not one**, because they are two protocols that do
 * not interoperate — an iPhone speaking AWDL and an Android phone speaking Wi-Fi Aware never
 * link, and one umbrella `p2pWifi` would hide exactly the fact a mixed fleet must know. They
 * share a body here; they do not share a name anywhere a person reads.
 */

/** BLE: low power, high reach, few slow connections. Its internals stay in `@syncmesh/ble`. */
export { bleTransport as ble, type BleOptions } from "@syncmesh/ble";
export type { BleRadio } from "@syncmesh/ble";

export type { Announcement } from "./lan/advert.js";
export { MAX_ROOM_BYTES, announcement, readAnnouncement } from "./lan/advert.js";
export type { LanAddress, LanNetwork, LanStream } from "./lan/network.js";
export { DEFAULT_GROUP, LanUnavailable, LanUnsupported } from "./lan/network.js";
export type { LanOptions } from "./lan/transport.js";
export { DEFAULT_ANNOUNCE_EVERY_MS, LAN_BANDWIDTH_BPS, lan } from "./lan/transport.js";

export type { P2pFabric, P2pPeer, P2pProtocol } from "./p2p/fabric.js";
export { P2pPathFailed, P2pUnsupported, announces, claimedBy, serviceName } from "./p2p/fabric.js";
export type { WebSocketOptions } from "./web-socket.js";
export { CannotListen, webSocket } from "./web-socket.js";

export type {
  BoundFabric,
  FabricOptions,
  RnP2pClosed,
  RnP2pData,
  RnP2pFound,
  RnP2pLost,
  RnP2pManager,
  RnP2pPath,
  RnP2pSubscription,
} from "./p2p/rn-p2p.js";
export { fabricFrom } from "./p2p/rn-p2p.js";
export type { Path, PathIo } from "./native-stream.js";
export { NativeStreamFailed, pathOver } from "./native-stream.js";
export type {
  BoundLan,
  RnLanAnnouncement,
  RnLanClosed,
  RnLanConnection,
  RnLanData,
  RnLanManager,
  RnLanOptions,
  RnLanSubscription,
} from "./lan/rn-lan.js";
export { lanFrom } from "./lan/rn-lan.js";
export type { P2pOptions } from "./p2p/transport.js";
export { DEFAULT_MAX_LINKS, P2P_BANDWIDTH_BPS, awdl, wifiAware } from "./p2p/transport.js";
