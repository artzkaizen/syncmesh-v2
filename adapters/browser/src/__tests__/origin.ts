import type { WirePort } from "@syncmesh/sqlite-wasm";

import type { ConnectScope } from "../broker.js";
import type { Elector } from "../election.js";
import type { HostScope } from "../host-worker.js";
import type { MeshLink } from "../link.js";
import type { CarrierPort } from "../rendezvous.js";
import type { MeshTab } from "../tabs.js";

import { broker } from "../broker.js";
import { hostOn } from "../host-worker.js";
import { joinMesh } from "../tabs.js";

/**
 * A browsing context, which is what a Web Lock is really held by and what killing one models.
 *
 * A named identity rather than a bare token, because every assertion about who holds the lock
 * reads better as the tab's own name than as an opaque object that happens to be `===`.
 */
export interface Context {
  readonly tab: string;
}

/** One waiting `navigator.locks.request`, and the context that made it. */
interface Waiter {
  readonly owner: Context;
  readonly granted: (lock: Lock | null) => Promise<void> | undefined;
}

/**
 * A `LockManager` for one origin, over contexts that can be killed.
 *
 * Everything the election relies on is in here and nothing else is: `ifAvailable` answers `null`
 * rather than queueing, a plain request queues in arrival order, and **killing a context releases
 * what it held and grants the lock to exactly one waiter**. That last line is the browser
 * behaviour the whole design leans on — no heartbeat, no lease — so it is the line a fake has to
 * be honest about.
 */
export function lockRoom() {
  const held = new Map<string, Context>();
  const queues = new Map<string, Waiter[]>();
  const queueOf = (name: string) => {
    const waiting = queues.get(name) ?? [];
    queues.set(name, waiting);
    return waiting;
  };
  const grant = (name: string, waiter: Waiter) => {
    held.set(name, waiter.owner);
    void waiter.granted({ name, mode: "exclusive" });
  };
  return {
    elector: (owner: Context): Elector => ({
      request: (name, options, granted) => {
        if (!held.has(name)) grant(name, { owner, granted });
        else if (options.ifAvailable === true) void granted(null);
        else queueOf(name).push({ owner, granted });
        return Promise.resolve();
      },
    }),
    /** The tab went away: what it held goes to the next waiter, and what it wanted is forgotten. */
    kill: (owner: Context) => {
      const theirs = [...held].filter(([, holder]) => holder === owner).map(([name]) => name);
      for (const name of theirs) {
        held.delete(name);
        const next = queueOf(name).shift();
        if (next !== undefined) grant(name, next);
      }
      for (const [name, waiting] of queues)
        queues.set(
          name,
          waiting.filter((waiter) => waiter.owner !== owner),
        );
    },
    /** What `navigator.locks.query().held` would say, for the assertions that quote it. */
    holders: () => [...held].map(([name, owner]) => ({ name, owner })),
  };
}

/** Message delivery over a real `MessageChannel` is a task, so a hop needs a turn to land. */
export const settle = async (turns = 8) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((next) => setTimeout(next, 0));
};

/**
 * One origin: a lock room and a running rendezvous.
 *
 * The `connect` gate is a real `MessageChannel` rather than a fabricated event, so the port a tab
 * hands the broker arrives the way a `SharedWorker` connection arrives — inside a `MessageEvent`,
 * transferred, and entangled with the tab.
 */
export function origin() {
  const room = lockRoom();
  const gate = new MessageChannel();
  const shared: ConnectScope = { onconnect: null };
  broker(shared);
  gate.port2.onmessage = (event) => shared.onconnect?.(event);
  return {
    room,
    connect: (): CarrierPort => {
      const wire = new MessageChannel();
      gate.port1.postMessage("connect", [wire.port2]);
      return wire.port1;
    },
  };
}

/** A host that says who it is, which is how a follower proves *which* tab answered it. */
const echo = (id: string) => (port: WirePort) => {
  port.onmessage = () => port.postMessage({ host: id });
};

export interface Tab {
  readonly id: string;
  /** The context the lock room kills: closing the tab takes its worker with it. */
  readonly owner: Context;
  readonly mesh: MeshTab;
  readonly close: () => void;
}

/**
 * A tab: a page, its own dedicated worker running the real {@link hostOn}, and a place in the
 * origin's rendezvous. `rendezvous: false` is the Chrome-on-Android case, where there is none.
 */
export async function openTab(
  where: ReturnType<typeof origin>,
  id: string,
  shared = true,
): Promise<Tab> {
  const control = new MessageChannel();
  const owner = { tab: id };
  const scope: HostScope = {
    postMessage: (message) => control.port2.postMessage(message),
    onmessage: null,
    navigator: { locks: where.room.elector(owner) },
  };
  control.port2.onmessage = (event) => scope.onmessage?.(event);
  hostOn(scope, echo(id));
  const joined = await joinMesh({
    worker: () => control.port1,
    rendezvous: shared ? () => where.connect() : false,
  });
  const mesh = joined.unwrap();
  return {
    id,
    owner,
    mesh,
    close: () => {
      mesh.leave();
      where.room.kill(owner);
    },
  };
}

/** Asks the host on the other end of a link who it is. */
export const whoHosts = (link: MeshLink) =>
  new Promise<string>((settle_) => {
    link.port.onmessage = (event) => settle_(event.data.host);
    link.port.postMessage("who");
  });
