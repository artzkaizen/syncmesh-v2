import type { WirePort } from "@syncmesh/sqlite-wasm";

/**
 * A port that reaches this origin's one mesh host, however it was found.
 *
 * The seam between finding the host and talking to it. A leader tab's link is a port to its own
 * dedicated worker; a follower's is a port the origin's rendezvous forwarded to the elected tab's
 * worker. Nothing on this side of it can tell, which is the point: {@link connectMesh} is the
 * same code either way, and every test of it runs over a plain `MessageChannel`.
 *
 * `role` is for the screen, not for the protocol — a header says which mode this tab is in, the
 * way the storage badge already names its tier.
 */
export interface MeshLink {
  readonly port: WirePort;
  /** Whether this tab's own worker is the host, or it is talking to another tab's. */
  readonly role: "leader" | "follower";
  /** The host went away (its tab closed). The link is dead; a new one must be asked for. */
  readonly onLost: (listener: () => void) => () => void;
  readonly close: () => void;
}

/**
 * A link over a port that is already connected, plus the button that declares the host dead.
 *
 * A `MessagePort` has no death of its own to report — it stays open and silent when the context
 * at the other end is gone — so whoever owns the election is the only thing that can know, and
 * this is where it says so. Over a `MessageChannel` in a test, nothing ever calls `lost`, which
 * is the honest reading of a host that cannot die.
 */
export interface DirectLink extends MeshLink {
  /** Tell every listener the host is gone. Idempotent: a link dies once. */
  readonly lost: () => void;
}

export const linkOver = (port: WirePort, role: MeshLink["role"]): DirectLink => {
  const listeners = new Set<() => void>();
  let dead = false;
  return {
    port,
    role,
    onLost: (listener) => {
      if (dead) listener();
      else listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    lost: () => {
      if (dead) return;
      dead = true;
      for (const listener of listeners) listener();
      listeners.clear();
    },
    close: () => listeners.clear(),
  };
};
