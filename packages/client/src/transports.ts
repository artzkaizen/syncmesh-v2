import type { PeerId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type {
  AdmissionHandler,
  LinkEvent,
  RouteCandidate,
  RouteMessage,
  RoutePolicy,
  Transport,
  TransportCondition,
  TransportContext,
  Unsubscribe,
} from "@syncmesh/transport";

import { createHub } from "@syncmesh/engine";
import { Result, TaggedError } from "@syncmesh/result";
import { KIND, ORDINARY_LINK, pickRoutes } from "@syncmesh/transport";

import type { AdmissionFacts } from "./admission.js";
import type { ChurnOptions } from "./churn.js";
import type { ForcedMedium, NoSuchTransport } from "./forced.js";

import { boundable, enforceBudget, enforceCeiling } from "./admission.js";
import { createChurn } from "./churn.js";
import { createForcing } from "./forced.js";

/**
 * How this device shapes its part of the mesh (book ch. 17).
 *
 * `maxLinks` is deliberately absent: it is a property of the radio, declared by the medium, and
 * an app handed a way to raise it has been handed a way to break the links it already has.
 */
export interface MeshShaping {
  /** Periodic random re-peering; `false` turns it off for a fleet that would rather not. */
  readonly churn?: ChurnOptions | false;
  /**
   * How this app would rather order the mediums that could carry a frame.
   *
   * The built-in order prices bandwidth and power, which suits a phone in a pocket and not every
   * deployment: a rack of devices on mains power would rather spend the radio than wait for a
   * relay, and a fleet paying for cellular would rather wait. This is where that preference goes,
   * so a transport somebody else writes can be ranked against the five shipped here without
   * editing any of them.
   *
   * **It orders and never excludes** — see `RoutePolicy`. Reachability stays the library's, because
   * that is the rule that decides whether a write is delivered at all, and a preference that could
   * suppress a medium could lose one.
   */
  readonly routes?: RoutePolicy;
  /**
   * Segments fleets that share an app but should not auto-connect — a depot's vans and a
   * warehouse's scanners running the same build.
   *
   * **An optimization, not a security control.** A dial-out bypasses it entirely, and anything
   * that reaches a link still faces the grant and the `allow` rules.
   */
  readonly group?: string;
  /**
   * An override for what membership cannot express — policies about the **radio**: "no links
   * inside this facility", "battery under 10%, keep the server link only", or quarantining a
   * suspect device topologically now, while its revocation is still propagating as data.
   *
   * It may only ever tighten: it overrides an allow and never manufactures one.
   */
  readonly admit?: AdmissionHandler;
  /**
   * Links this device holds across every medium at once. Absent means no ceiling, which is the
   * honest answer for a phone with two radios and no way to exhaust anything.
   *
   * This is not `maxLinks` — that is each medium's own, declared by the medium and never
   * configured here, because an app handed a way to raise a radio's limit has been handed a way
   * to break the links it already has. This one is about the *process*.
   */
  readonly maxConnections?: number;
}

/**
 * Something outside the mesh that knows the world may have moved, wired to the door that acts on it.
 *
 * `Transport.wake` is the door — *check the link now, because something outside knows it may have
 * changed* — and a `Knock` is what knocks on it. They are two halves that know different things: a
 * transport knows how to re-establish its own link and nothing about the platform it runs on, and a
 * platform signal knows the phone came back to the foreground and nothing about sockets. The mesh
 * is the only thing holding both, so the mesh is where they meet.
 *
 * **This exists because a socket does not always learn that its network went away.** Switch a
 * phone's Wi-Fi off and the connection underneath is abandoned rather than closed: no `close` event
 * arrives, so the relay went on believing it had a live link for the ~37 seconds its keepalive
 * deadline takes to expire, with writes sitting safe on disk and going nowhere. Bluetooth has the
 * same shape — an adapter switching off is not a link ending, so nothing restarted discovery. Both
 * were found by a person using the app, twice, weeks apart, and neither is something a transport
 * can notice for itself.
 *
 * **It is a seam rather than an app's job on purpose.** Before this, recovery was a loop over
 * transports and an `AppState` listener written in application code, which meant every app built on
 * this would write the same loop, and each would get it slightly wrong in its own way — forgetting
 * to unsubscribe, capturing the transport array so a radio switched on later never woke, waking on
 * `isConnected` instead of `isInternetReachable`. An app should get recovery by existing.
 *
 * A `Knock` subscribes when the mesh starts and is let go when it stops; returning the unsubscribe
 * *is* the shape, because a subscription whose owner cannot let go of it outlives the mesh it was
 * made for. `@syncmesh/react-native` ships the two a phone has.
 *
 * @example
 * import { foreground } from "@syncmesh/react-native";
 * import { reachability } from "@syncmesh/react-native/network";
 *
 * const app = createClient({ schema, procedures, knocks: [foreground(), reachability()] });
 */
export type Knock = (wake: () => void) => Unsubscribe;

/** The medium refused to start, or the set had already stopped; the mesh runs on without it. */
export class TransportAddFailed extends TaggedError("TransportAddFailed")<{
  readonly transport: string;
  message: string;
  cause?: unknown;
}> {}

/** The running half of the mesh: every configured transport, started once, stopped together. */
export interface RunningTransports {
  readonly ready: () => Promise<void>;
  /**
   * Every source that could still fill a scope has finished its first pass — the question an app
   * must answer before it draws an empty state. Sources are awaited nearest first (RFC-0019), so
   * a radio holding nothing never resolves ahead of the relay that holds everything.
   *
   * The device's own storage is not among them: boot replays the log before a mesh exists, so by
   * the time this can be called it has already answered.
   */
  readonly settled: () => Promise<void>;
  readonly running: () => boolean;
  /**
   * The transports that should carry this message, best first (RFC-0012 §2). Offline ones are
   * gone, and a class a medium refuses outright — presence, to a dormant expensive radio — is
   * gone with them.
   */
  readonly route: (message: RouteMessage, among?: readonly Transport[]) => readonly Transport[];
  readonly requestGrant: (invite?: string) => void;
  /** One ephemeral value to every transport worth putting it on; the rest ignore or refuse it. */
  readonly sendPresence: (wire: Uint8Array) => void;
  /** The transports that can carry bytes out of band (D18); empty when no medium here can. */
  readonly withBlobs: () => readonly Transport[];
  /** The mediums currently running, in attach order. */
  readonly list: () => readonly Transport[];
  /** Whether one medium is up, as its own `onStatus` last said; `undefined` if it never has. */
  readonly online: (transport: Transport) => boolean | undefined;
  /**
   * Every medium's link-level endings in one feed, following the set as it changes (book ch. 18).
   *
   * One subscription rather than one per transport, because whoever reads these — a log, a
   * diagnostic pane — does not know which radios exist and should not have to re-subscribe when
   * a settings toggle adds one. That is the bug `$status.subscribe` still has: it captures the
   * transports it was given, so a medium enabled afterwards is silent to it forever. This one
   * subscribes on `add` and lets go on `remove`, which is the only place that knows.
   *
   * A medium that cannot say anything about its links is simply absent from the feed.
   */
  readonly onLinkEvent: (listener: (event: LinkEvent) => void) => Unsubscribe;
  /** Starts one more medium mid-life — a settings toggle, a diagnostic pane (book ch. 8, 16). */
  readonly add: (transport: Transport) => Promise<ResultType<void, TransportAddFailed>>;
  /**
   * Stops one medium by name and takes its route away; `drain` flushes its queue first.
   * Removing a transport removes a route, never replica data. `false` when no such name runs.
   *
   * A medium being held by {@link RunningTransports.force} is removed whole: the stand-in leaves
   * the set and the instance behind it is let go, because a name that is gone has nothing to be
   * released back to.
   */
  readonly remove: (name: string, options?: { readonly drain?: boolean }) => Promise<boolean>;
  /**
   * Holds one medium in a condition it cannot be put into from a laptop — `radio-off`,
   * `discovery-failed`, `connecting-failed` — so the states a diagnostic screen draws can be
   * reached on the machine the screen is being written on (book ch. 18).
   *
   * The real medium is **stopped and kept**, and a stand-in that reports `as` takes its seat at
   * the same position. Everything downstream sees an ordinary medium that is carrying nothing:
   * `$status` reports the condition, the route scorer skips it, presence and blobs go elsewhere,
   * and a device with every medium held reads as `offline` health — which is the point, because
   * a forced state that only the panel that set it can see is a bug report waiting to happen.
   *
   * Forcing an already-held medium changes what it says; it does not stack. Nothing here is
   * remembered anywhere: a reload has no held mediums, because a toggle that survives a restart
   * is a toggle somebody spends an afternoon looking for.
   */
  readonly force: (
    name: string,
    as: TransportCondition,
  ) => Promise<ResultType<void, NoSuchTransport>>;
  /**
   * Gives a held medium back its seat and starts it again — the same `start` an `add` runs, so
   * what comes back is a medium in a state this device could have reached on its own.
   *
   * It can fail for the ordinary reason a medium fails to open, and then the name is no longer
   * held and no longer running, which is the honest outcome: the radio the developer switched
   * back on did not come up.
   */
  readonly release: (
    name: string,
  ) => Promise<ResultType<void, NoSuchTransport | TransportAddFailed>>;
  /** Which mediums are being held by hand, and in what — empty on every device nobody has touched. */
  readonly forced: () => readonly ForcedMedium[];
  readonly stop: () => Promise<void>;
}

/**
 * The facts everything that ranks a peer reads: one view, so the budget and churn cannot disagree
 * about which link is worth least. Read when a ranking runs rather than when the mesh opens —
 * churn's first round is minutes away, and the acks it ranks on are not the boot's.
 */
const factsFrom = (context: TransportContext) => (): AdmissionFacts => ({
  acks: () => context.engine.acks(),
  held: () => context.engine.coverage().synced,
  partitionsOf: (device: PeerId) => context.grants.grantFor(device)?.partitions.map(String),
  self: context.identity.peerId,
});

/**
 * Every medium told to look at its link again, because something outside said the world moved.
 *
 * Takes the **live** set rather than closing over the one a mesh was constructed with. A radio
 * switched on from a settings screen half an hour into a session is exactly the medium a foreground
 * signal should reach, and a loop over a captured array would leave it out forever — the same bug
 * `$status.subscribe` has and {@link RunningTransports.onLinkEvent} was written to avoid.
 *
 * Nothing here is selective about which mediums are worth waking, because nothing here can be:
 * waking a healthy transport is free by contract ({@link Transport.wake}), and a medium whose link
 * cannot go stale without saying so declares no `wake` at all and is skipped by its own absence.
 */
const wakeEvery = (transports: readonly Transport[]): void => {
  for (const transport of transports) transport.wake?.();
};

/**
 * Score the candidates and hand back the transports behind the survivors (RFC-0012 §2).
 *
 * Candidates are matched to their transport by identity rather than by name, so two mediums
 * configured under one name cannot collapse into each other — the name is the scorer's tie-break,
 * and a tie-break is not an identifier.
 *
 * A medium nothing has said anything about is treated as up. A send that turns out to be wrong
 * fails loudly and resyncs, where assuming down would keep a working link idle until it happened
 * to announce itself.
 */
const scoreRoutes = (
  among: readonly Transport[],
  online: ReadonlyMap<Transport, boolean>,
  message: RouteMessage,
  policy: RoutePolicy | undefined,
): readonly Transport[] => {
  const owners = new Map<RouteCandidate, Transport>();
  const candidates = among.map((t) => {
    const candidate = {
      id: t.name,
      online: online.get(t) ?? true,
      ...(t.route?.() ?? ORDINARY_LINK),
    };
    /**
     * What this medium claims about peers, for routing: adjacency and transitive reach together.
     *
     * `reaches` is the links it holds and `delivers` is what it can carry to through them — a
     * relay's one socket and the room behind it. Routing wants both, because the question a frame
     * asks is "can you get this to P", not "is P on the other end of a cable". They stay separate
     * on the transport itself because `churn` counts `reaches` against `maxLinks` before closing
     * something, and a relay answering forty there would be told to hang up links it never had.
     *
     * Absent from both stays absent: a medium that tracks neither says nothing, which `pickRoutes`
     * reads as a shrug rather than a refusal.
     */
    const adjacency = t.reaches?.();
    const transitive = t.delivers?.();
    if (adjacency !== undefined || transitive !== undefined)
      Object.assign(candidate, { reaches: new Set([...(adjacency ?? []), ...(transitive ?? [])]) });
    owners.set(candidate, t);
    return candidate;
  });
  return pickRoutes(candidates, message, policy).flatMap((c) => owners.get(c) ?? []);
};

export function runTransports(
  transports: readonly Transport[],
  context: TransportContext,
  shaping: MeshShaping = {},
  knocks: readonly Knock[] = [],
): RunningTransports {
  /**
   * Whether each medium is up, from the one place that says so. A transport that has not spoken
   * yet is assumed up: a send that turns out to be wrong fails loudly and resyncs, where
   * assuming down would keep a working link idle until it happened to announce itself.
   *
   * Subscribed before anything is started, so a medium that fails while opening is heard.
   */
  const online = new Map<Transport, boolean>();
  /** The live set: construction seeds it, `add`/`remove` reshape it, everything reads it. */
  const active: Transport[] = [...transports];
  const watching = new Map<Transport, () => void>();
  /** One feed for every medium's links, so a reader holds one subscription and not one per radio. */
  const linkEvents = createHub<LinkEvent>();
  const watch = (t: Transport): void => {
    const offStatus = t.onStatus?.((up) => void online.set(t, up)) ?? (() => undefined);
    const offLinks = t.onLinkEvent?.((event) => linkEvents.emit(event)) ?? (() => undefined);
    watching.set(t, () => {
      offStatus();
      offLinks();
    });
  };
  for (const t of active) watch(t);

  // the context each transport actually starts with: the caller's, plus the routing question
  // only this set can answer — a transport started by a test gets the caller's own and carries
  // everything, which is the behaviour every transport had before link admission
  const routed: TransportContext = {
    ...context,
    carries: (name, message) => carries(name, message),
  };
  const starts = new Map<Transport, Promise<void>>(active.map((t) => [t, t.start(routed)]));
  const started = Promise.all(starts.values());
  let running = true;

  // guarded on `running` because a knock is a subscription on somebody else's event source, and a
  // signal arriving after `stop()` let go would redial a socket the mesh has already finished with
  const answered = knocks.map((knock) => knock(() => void (running && wakeEvery(active))));

  /**
   * Holds each radio to the links it says it sustains (E28).
   *
   * Run when the facts it selects on change — an acknowledgement moves a peer's cursor, a grant
   * changes which partitions are shared — rather than on a timer. There is no clock in this file,
   * and adding one to ask a question whose inputs announce themselves would be a worse answer.
   */
  const facts = factsFrom(context);
  const sweep = (): void => {
    if (!running) return;
    const now = facts();
    // each medium to what it sustains, then the device to what it sustains: a radio's limit is
    // about the radio, and the ceiling is about the process holding all of them at once
    for (const transport of active) enforceBudget(transport, now);
    if (shaping.maxConnections !== undefined) enforceCeiling(active, now, shaping.maxConnections);
  };
  /**
   * Nothing to enforce, nothing to watch: a set whose transports cannot close a link is not one a
   * budget applies to, and subscribing anyway would be work done for no possible outcome — which
   * is also why a transport driven with no mesh behind it never touches the engine at all. A
   * transport added later can be the first boundable one, so this is asked again on `add`.
   */
  const offAdmission: (() => void)[] = [];
  const watchAdmission = (): void => {
    if (offAdmission.length > 0 || !active.some(boundable)) return;
    offAdmission.push(context.engine.onAcknowledge(sweep), context.grants.onRegistered(sweep));
  };
  watchAdmission();

  /** Every mention of one medium, forgotten. It does **not** stop it: the two callers differ. */
  const drop = (transport: Transport): void => {
    const at = active.indexOf(transport);
    if (at >= 0) active.splice(at, 1);
    watching.get(transport)?.();
    watching.delete(transport);
    online.delete(transport);
    starts.delete(transport);
  };

  /**
   * Starts a medium already in the set, and takes it back out if it will not open.
   *
   * Shared by `add` and `release` so that a medium switched back on goes through the same door a
   * medium added at runtime does. Two copies of "start it, and undo the set if it rejects" is how
   * one of them ends up leaving a half-attached transport behind.
   */
  const open = async (transport: Transport): Promise<ResultType<void, TransportAddFailed>> => {
    const opening = transport.start(routed);
    starts.set(transport, opening);
    const outcome = await Result.tryPromise({
      try: () => opening,
      catch: (cause) =>
        new TransportAddFailed({
          transport: transport.name,
          message: `${transport.name} failed to start`,
          cause,
        }),
    });
    if (outcome.isErr()) {
      drop(transport);
      return Result.err(outcome.error);
    }
    watchAdmission();
    // the newcomer may be the first medium a budget applies to
    sweep();
    return Result.ok(undefined);
  };

  /**
   * Holding a medium in a condition by hand (book ch. 18), over the two moves that set owns: find
   * a name, and put one medium in another's seat. **At the same index** — attach order is the
   * order `$peers` reports a peer's mediums in, and a radio that went off and came back at the end
   * of the list would quietly re-order somebody's diagnosis.
   */
  const forcing = createForcing({
    find: (name) => active.find((t) => t.name === name),
    open: (transport) => open(transport),
    swap: async (out, into) => {
      const at = active.indexOf(out);
      drop(out);
      active.splice(at < 0 ? active.length : at, 0, into);
      watch(into);
      await out.stop();
    },
  });

  /**
   * The other half of island prevention (book ch. 17). The budget keeps the best links, which is
   * correct per device and wrong for the room; churn is what stops a saturated room settling into
   * a clique. It acts only on a medium at its budget, so a small room pays nothing for it.
   */
  const churn =
    shaping.churn === false
      ? undefined
      : createChurn(() => active, facts, shaping.churn === undefined ? {} : shaping.churn);

  /**
   * Score the candidates and hand back the transports behind the survivors.
   *
   * Candidates are matched to their transport by identity rather than by name, so two mediums
   * configured under one name cannot collapse into each other — the name is the scorer's
   * tie-break, and a tie-break is not an identifier.
   */
  /**
   * Whether one transport is among the links this frame should go on (E28).
   *
   * Asked per link rather than decided centrally, because each bridge already owns its own send:
   * the mesh says which links a frame belongs on and the links do the rest, which is a smaller
   * change than moving every send into one dispatcher and leaves a transport able to run with no
   * mesh at all — which is how every transport test drives one.
   */
  const carries = (transport: string, message: RouteMessage): boolean =>
    route(message).some((picked) => picked.name === transport);

  const route = (
    message: RouteMessage,
    among: readonly Transport[] = active,
  ): readonly Transport[] => scoreRoutes(among, online, message, shaping.routes);

  /**
   * Every transport worth putting this on, in order — not the single best one.
   *
   * The scorer as a filter, because a broadcast is what these two calls are. Which one link
   * reaches a given peer is a question nothing here can answer, since no transport publishes a
   * per-peer link list, so narrowing to the winner would silently stop talking to whoever was
   * only reachable down the link that lost. Choosing arrives with link admission (RFC-0012 §1).
   * What the scoring settles today is which links are worth trying at all.
   */
  const every = (message: Omit<RouteMessage, "redundancy">): readonly Transport[] =>
    route({ ...message, redundancy: active.length });

  return {
    route,
    ready: async () => {
      await started;
      await Promise.all([...starts.values()].map((p) => p.catch(() => undefined)));
      await Promise.all(active.map((t) => t.whenReady()));
    },
    running: () => running,
    settled: async () => {
      await Promise.all(active.map((t) => t.whenReady()));
      const nearestFirst = [...active].sort((x, y) => (x.priority ?? 1) - (y.priority ?? 1));
      // sequentially, and in that order: waiting on them together would let the furthest source
      // decide when the answer is ready, which is exactly the race this exists to lose
      for (const transport of nearestFirst) await transport.caughtUp?.();
    },
    requestGrant: (invite) => {
      // every link that is up, not the best one: this is the ask that gets a device admitted at
      // all, and whoever can answer it may be reachable on only one of them
      for (const t of every({ cls: KIND.grantRequest, bytes: 0 })) t.requestGrant?.(invite);
    },
    sendPresence: (wire) => {
      for (const t of every({ cls: KIND.presence, bytes: wire.length })) t.sendPresence?.(wire);
    },
    withBlobs: () => active.filter((t) => t.putBlob !== undefined),
    list: () => [...active],
    online: (transport) => online.get(transport),
    onLinkEvent: linkEvents.subscribe,
    add: async (transport) => {
      if (!running)
        return Result.err(
          new TransportAddFailed({ transport: transport.name, message: "the mesh has stopped" }),
        );
      watch(transport);
      active.push(transport);
      return open(transport);
    },
    remove: async (name, options = {}) => {
      const held = active.find((t) => t.name === name);
      if (held === undefined) return false;
      // out of the set first, so no new frame routes onto a medium that is going away
      drop(held);
      // the instance behind a held name goes with it — it was already stopped when it was held
      forcing.forget(name);
      if (options.drain === true) await held.flush?.().catch(() => undefined);
      await held.stop();
      return true;
    },
    force: forcing.force,
    release: forcing.release,
    forced: forcing.list,
    stop: async () => {
      running = false;
      forcing.clear();
      // the platform's listeners first: they are the only subscriptions here that outlive the
      // process this mesh runs in, and one left behind holds every transport it captured with it
      for (const off of answered) off();
      for (const stopWatching of watching.values()) stopWatching();
      watching.clear();
      for (const off of offAdmission) off();
      churn?.stop();
      await started.catch(() => undefined);
      await Promise.all(active.map((t) => t.stop()));
    },
  };
}
