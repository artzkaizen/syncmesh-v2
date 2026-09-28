/* oxlint-disable anti-slop/no-unknown-parameters -- the tab's end of a `postMessage`: a pushed reading arrives as `unknown` and is the host's own `DeviceReading`, revived here */

import type { AuthStatus, Mesh, MeshStatus } from "@syncmesh/client";
import type { LinkEvent, Route, Transport } from "@syncmesh/transport";

import { Temporal } from "@syncmesh/temporal";

import type { DeviceReading, LinkReading, MediumReading } from "./protocol.js";
import type { MeshWire } from "./wire.js";

import { MeshCallFailed } from "./protocol.js";

/**
 * The device, as every window of it is told.
 *
 * A window is not a device: it holds no radio, keeps no route table and signs no session, so none
 * of the *controls* on `$transports`, `$routes` or `$auth` sit on a follower. The **facts** on
 * them do, because a header pill that says *Offline* and a settings screen that says *Bluetooth
 * is off* are read in windows and nowhere else. They cross the way `auth` already does: the host
 * pushes one reading whenever any of its sources moves, and a tab holds the last one and answers
 * synchronously from it — the same shape `principal` has had since a handler needed it during a
 * render.
 *
 * One reading rather than five feeds, because the five hooks that draw it subscribe to
 * overlapping pairs (`useStatus` watches status *and* links; `usePeers` watches links *and*
 * status) and dedupe by value on their own side. What does not fit in a reading is the link
 * event itself — a fact with a sequence, not a state — so that is its own topic.
 */

/** What the host reads off its mesh to build one {@link DeviceReading}. */
export type DeviceSource = Pick<Mesh, "status" | "peers" | "routes"> & {
  readonly transports: Pick<Mesh["transports"], "list" | "onLinkEvent" | "forced">;
  readonly auth: Pick<Mesh["auth"], "status" | "subscribe">;
};

/** The mesh's facts about itself, as they cross a port: no functions, and every instant a bigint. */
export const deviceReading = (mesh: DeviceSource): DeviceReading => {
  const session = mesh.auth.status();
  return {
    status: mesh.status.get(),
    media: mesh.transports.list().map((medium) => ({
      name: medium.name,
      kind: medium.kind,
      reaches: medium.reaches === undefined ? undefined : [...medium.reaches()],
    })),
    forced: mesh.transports.forced(),
    peers: mesh.peers.graph(),
    routes: mesh.routes
      .all()
      .map((route) => ({ ...route, expiresAt: route.expiresAt.epochNanoseconds })),
    auth: { principal: session.principal, expiresAt: session.expiresAt?.epochNanoseconds ?? null },
  };
};

/** One link-level fact, its instant flattened for the clone. */
const linkReading = (event: LinkEvent): LinkReading => ({
  ...event,
  at: event.at.epochNanoseconds,
});

/** The four subscriptions one reading follows; any of them moving re-sends the whole. */
const watchDevice = (mesh: DeviceSource, tell: () => void): (() => void) => {
  const offs = [
    mesh.status.subscribe(tell),
    mesh.transports.onLinkEvent(tell),
    mesh.routes.onChange(tell),
    mesh.auth.subscribe(tell),
  ];
  return () => {
    for (const off of offs) off();
  };
};

/** The host's two feeds behind a tab's device: the reading, re-sent whole, and each link event. */
export const deviceFeed = (
  mesh: DeviceSource,
  topic: "device" | "links",
  emit: (payload: unknown) => void,
): (() => void) =>
  topic === "device"
    ? watchDevice(mesh, () => emit(deviceReading(mesh)))
    : mesh.transports.onLinkEvent((event) => emit(linkReading(event)));

/**
 * A tab's end: the device's facts, answered synchronously from the last reading.
 *
 * `status`, `transports`, `peers`, `routes` and `session` are the slices the five diagnostic
 * hooks read, under the names the mesh gives them. Before the first reading has landed, `status`
 * says `opening` — the word `createClient` uses before there is a mesh — and the rest throw with
 * a sentence, because *not heard yet* is not the same fact as *nothing there*. `heard` is what
 * `$ready` waits on so that nothing under a provider ever sees that state.
 */
export interface RemoteDevice {
  readonly status: Mesh["status"];
  readonly transports: Pick<Mesh["transports"], "list" | "onLinkEvent" | "forced">;
  readonly peers: Pick<Mesh["peers"], "graph">;
  readonly routes: Pick<Mesh["routes"], "all" | "onChange">;
  readonly session: Pick<Mesh["auth"], "status" | "subscribe">;
  /** The first reading has landed. */
  readonly heard: () => Promise<void>;
  readonly close: () => void;
}

/** What `$status` says before the device has been heard: no sources, and the one word for it. */
const OPENING: MeshStatus = { health: "opening", sources: new Map() };

/** A reading and the values revived out of it, built once per arrival so identities hold. */
interface Held {
  readonly reading: DeviceReading;
  readonly media: readonly Transport[];
  readonly routes: readonly Route[];
  readonly session: AuthStatus;
}

const refuse = (what: string) => (): Promise<never> =>
  Promise.reject(
    new MeshCallFailed({
      path: `transports.${what}`,
      message: "a window holds no radio: the device's media are the origin's to start and stop",
    }),
  );

/**
 * One medium as a window holds it, in the shape `$transports.list()` has.
 *
 * The facts are the device's — name, kind, who it reaches — and the three members the port
 * requires are the honest version for a window: `whenReady` resolves because the medium is
 * already running where it lives, and `start`/`stop` refuse with a sentence rather than doing
 * nothing quietly. The same stand-in shape `@syncmesh/client` uses for a held medium.
 */
const mediumOf = (medium: MediumReading): Transport => {
  const reaches = medium.reaches === undefined ? undefined : new Set(medium.reaches);
  return {
    name: medium.name,
    ...(medium.kind !== undefined && { kind: medium.kind }),
    ...(reaches !== undefined && { reaches: () => reaches }),
    start: refuse("start"),
    stop: refuse("stop"),
    whenReady: () => Promise.resolve(),
  };
};

const revive = (reading: DeviceReading): Held => ({
  reading,
  media: reading.media.map(mediumOf),
  routes: reading.routes.map((route) => ({
    ...route,
    expiresAt: Temporal.Instant.fromEpochNanoseconds(route.expiresAt),
  })),
  session: {
    principal: reading.auth.principal,
    expiresAt:
      reading.auth.expiresAt === null
        ? null
        : Temporal.Instant.fromEpochNanoseconds(reading.auth.expiresAt),
  },
});

const linkOf = (reading: LinkReading): LinkEvent => ({
  ...reading,
  at: Temporal.Instant.fromEpochNanoseconds(reading.at),
});

export function remoteDevice(wire: MeshWire): RemoteDevice {
  let held: Held | undefined;
  const watchers = new Set<() => void>();
  let offTopic: (() => void) | undefined;

  const accept = (payload: unknown): void => {
    // SAFETY: the host answers `device` and posts the `device` topic with its own `deviceReading`
    held = revive(payload as DeviceReading);
    for (const watcher of watchers) watcher();
  };
  const ask = (): Promise<void> =>
    wire.ask<DeviceReading>({ kind: "call", path: "device", args: [] }).then(accept);
  const first = ask();
  // observed here so a dead port is never an unhandled rejection; `$ready` still rejects for the
  // caller that awaits it
  first.catch(() => undefined);

  /**
   * One host-side subscription while anybody is watching, and a fresh reading on the way in: the
   * host only speaks on change, so a tab that starts watching after one would otherwise hold the
   * reading it was handed at connect until the next.
   */
  const watch = (listener: () => void): (() => void) => {
    watchers.add(listener);
    if (offTopic === undefined) {
      offTopic = wire.listen("device", accept);
      void ask().catch(() => undefined);
    }
    return () => {
      watchers.delete(listener);
      if (watchers.size > 0 || offTopic === undefined) return;
      offTopic();
      offTopic = undefined;
    };
  };

  const heard = (): Held => {
    if (held !== undefined) return held;
    throw new Error("this window has not heard the device yet — await `$ready` before reading it");
  };

  return {
    status: {
      get: () => held?.reading.status ?? OPENING,
      subscribe: watch,
    },
    transports: {
      list: () => heard().media,
      onLinkEvent: (listener) =>
        // SAFETY: the host posts the `links` topic with its own `linkReading`
        wire.listen("links", (payload) => listener(linkOf(payload as LinkReading))),
      forced: () => heard().reading.forced,
    },
    peers: { graph: () => heard().reading.peers },
    routes: { all: () => heard().routes, onChange: watch },
    session: { status: () => heard().session, subscribe: watch },
    heard: () => first,
    close: () => {
      offTopic?.();
      offTopic = undefined;
      watchers.clear();
    },
  };
}
