import type { PeerId } from "@syncmesh/kernel";
import type { Transport, TransportCondition } from "@syncmesh/transport";

import { omitUndefined } from "@syncmesh/result";
import { webSocket } from "@syncmesh/transports";

import type { Reaching } from "./reach.js";

import { serveReach } from "./reach.js";

/**
 * The one line the rest of this app was waiting on, and the commentary that says whether it worked.
 *
 * `replica.ts` used to promise that adding a transport was a line in `mesh-worker.ts` and nothing
 * else. Two thirds of that survived the move into the worker. The line really is one line —
 * `transports: dialRelay(device.peerId)` beside the driver — and nothing above the worker knows a
 * transport exists, so no component, query or route changed. What it missed is that a *second
 * device* is not a transport feature: the same build on two machines was one author, because the
 * device key came out of the bundle. See `identity.ts`.
 *
 * The third thing it missed is this file's other half. A relay that is not running must look
 * different from one that is, or the app is claiming a convergence it is not getting — so the
 * medium's own condition is broadcast to every window (`reach.ts`) and drawn as a badge.
 */

/** A relay serves one room per path, and this app is one room. */
const ROOM = "issues";

/** Beside the dev server rather than on it: `bun run --cwd apps/issues relay`. */
const PORT = "5241";

/**
 * `ws://<wherever this page came from>:5241/issues`, unless the build says otherwise.
 *
 * Derived rather than configured, because a fixed `localhost` URL is the line that makes the demo
 * work on the machine it was written on and nowhere else — open the app from another device on the
 * network and it would dial that device's own loopback. `self.location` in a dedicated worker is
 * the worker script's URL, which is the dev server's, which is the host the person actually typed.
 *
 * `VITE_RELAY_URL=""` is how a build says **no relay**: the app is local-only and the badge says
 * so, which is a different sentence from "the relay is down".
 */
const relayUrl = (): string | undefined => {
  const configured = import.meta.env["VITE_RELAY_URL"];
  if (configured !== undefined) return configured === "" ? undefined : configured;
  const scheme = self.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${self.location.hostname}:${PORT}/${ROOM}`;
};

/**
 * The medium's own word for what it is doing, in the four states this app's badge draws.
 *
 * Read off `Transport.condition()` rather than counted here, because the reduction from endings to
 * a condition is the transport's own and a second copy of it would be a second opinion. `unknown`
 * is the honest start — dialled, nothing back yet — and is the only one that is not a verdict.
 */
const reachingOf = (condition: TransportCondition | undefined): Reaching => {
  if (condition === "ok") return "online";
  if (condition === "connecting-failed" || condition === "temporarily-unavailable")
    return "unreachable";
  return "reaching";
};

/**
 * Every medium this device carries the mesh over, which is a relay or nothing.
 *
 * No BLE and no LAN: a browser tab has neither, and listing a medium it cannot open would put a
 * row in the Transports panel that is permanently `no-hardware`. A relay is what a browser has.
 */
export function dialRelay(device: PeerId): readonly Transport[] {
  const announce = serveReach();
  const url = relayUrl();
  if (url === undefined) {
    announce({ state: "off", device });
    return [];
  }
  const transport = webSocket({ id: ROOM, bootstrap: [url] });
  announce({ state: "reaching", device, url });
  transport.onLinkEvent?.((event) => {
    const state = reachingOf(transport.condition?.());
    announce({ state, device, url, ...omitUndefined({ why: event.why }) });
  });
  return [transport];
}
