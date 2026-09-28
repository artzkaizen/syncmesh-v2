import type { ForcedMedium } from "@syncmesh/client";
import type { Unsubscribe } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";
import type { TransportCondition, TransportKind } from "@syncmesh/transport";

import { TaggedError } from "@syncmesh/result";

/**
 * The one thing the inspector may change, and the reason it is not part of {@link DevtoolsSource}.
 *
 * `DevtoolsSource` is read-only by construction — plain serialisable snapshots, one coalesced
 * feed, three engine subscriptions for the whole devtool — and that property is worth more than
 * any control. So the controls are a **second argument**, not a fourteenth member: a host that
 * passes no `controls` gets an inspector that provably cannot touch the running system, and a
 * production build passes none. The opt-in *is* the safety property, which is why it is spelled as
 * an extra parameter rather than as a flag on an object that already has the power.
 *
 * What it exists for is not convenience. You cannot turn off a real Bluetooth radio from
 * JavaScript, put a LAN peer out of range, or make a relay flap; Chrome's own offline toggle only
 * knows about HTTP. The Transports panel draws four distinct states for a medium — carrying,
 * cannot say, offline, refusing — and on a laptop there was no way to produce three of them. A
 * panel whose states cannot be reached is a panel nobody has ever seen work.
 *
 * **Held mediums do not survive a reload.** Nothing here is written to storage, deliberately: a
 * toggle that outlived the page is a toggle somebody spends an afternoon hunting, and a refresh is
 * the one escape route every developer already knows. The state is visible in the app while it
 * lasts — `mesh.transports.forced()` names it, `$status` reports the condition, and the bubble
 * carries a mark whether or not the panel is open.
 */

/**
 * The action did not happen, and this is why in a sentence a panel can render.
 *
 * One error rather than the two the mesh raises, because a panel's whole response to either is the
 * same: say what was refused, and leave the toggle where it was. The mesh's own
 * `NoSuchTransport`/`TransportAddFailed` stay where they can be branched on.
 */
export class ControlRefused extends TaggedError("ControlRefused")<{
  readonly transport: string;
  readonly action: "force" | "release";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Which conditions each medium can honestly be held in.
 *
 * Not every word in `TransportCondition` is true of every medium: a websocket has no radio to
 * switch off and no permission to be denied, and a picker that offered `no-permission-central` for
 * one would be teaching a developer that a relay can be refused by a Bluetooth permission dialog.
 * The same discipline as the rest of this package — a thing that cannot be said is not offered —
 * applied to the vocabulary rather than to a value.
 *
 * `ok` is absent from every row on purpose. Holding a medium in `ok` is not a forced state; it is
 * releasing it, which has its own verb.
 */
export const FORCEABLE = {
  ble: [
    "radio-off",
    "no-permission-central",
    "no-permission-peripheral",
    "discovery-failed",
    "connecting-failed",
    "backgrounded",
    "no-hardware",
    "temporarily-unavailable",
  ],
  awdl: ["radio-off", "discovery-failed", "connecting-failed", "temporarily-unavailable"],
  "wifi-aware": ["radio-off", "discovery-failed", "connecting-failed", "temporarily-unavailable"],
  lan: ["discovery-failed", "listen-failed", "connecting-failed", "temporarily-unavailable"],
  websocket: ["connecting-failed", "temporarily-unavailable"],
  http: ["connecting-failed", "temporarily-unavailable"],
  // a transport built out of two functions says nothing about itself, so neither does this
  unknown: ["connecting-failed", "temporarily-unavailable"],
} satisfies Record<TransportKind, readonly TransportCondition[]>;

export interface DevtoolsControls {
  /**
   * Which mediums are being held by hand, and in what. Empty on every device nobody has touched,
   * which is what makes it safe for a badge to read on every render.
   */
  readonly forced: () => readonly ForcedMedium[];
  /**
   * Stops the medium, keeps the instance, and seats a stand-in that says `as`.
   *
   * Parking rather than removing, because a removed transport is an instance the devtool would
   * have to reconstruct to put back — and a transport the devtool built is one the app never
   * configured. What comes back from {@link DevtoolsControls.release} is the object the host
   * passed to `createMesh`, started again through the same door `$transports.add` uses, which is
   * how a released medium lands in a state the device could have reached on its own.
   */
  readonly force: (name: string, as: TransportCondition) => Promise<Result<void, ControlRefused>>;
  readonly release: (name: string) => Promise<Result<void, ControlRefused>>;
  /**
   * Fires after each action that went through this object — for a badge, not for a panel's data.
   *
   * No coalescing and no channel set, because the only thing that moves this is a person clicking,
   * and a hub that fires once a minute at human speed does not need a scheduler in front of it.
   */
  readonly onChange: (listener: () => void) => Unsubscribe;
}
