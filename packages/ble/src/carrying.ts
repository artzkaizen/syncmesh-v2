import type { PeerId } from "@syncmesh/kernel";

/**
 * Whether a proven link carried a packet in within one keepalive: the evidence a `wake` reads before it restarts.
 *
 * `Transport.wake` must be free on a radio that is carrying, and a restart is not: it drops every
 * session this device holds, and the neighbour on the far side of each is told nothing — it keeps
 * a link to a session that no longer exists, believes it already has the peer, does not dial, and
 * waits out its liveness deadline, 12.5 seconds, before anything crosses again. A reachability
 * knock wakes every medium, so every network change did that to every Bluetooth neighbour (chaos
 * soak, `--blobs`, seed 3 at four devices). A proven link heard inside one keepalive is a radio
 * that works, and a wake leaves it alone; one that has heard nothing is restarted as before.
 *
 * One reading for the whole radio: a single healthy link spares every other link, the scan and
 * the advertisement from the restart. A link that died beside it is still caught by its own
 * liveness deadline, and an adapter switched off by `watchPower`.
 */
export const carrying = (proven: ReadonlyMap<string, PeerId>, everyMs: number) => {
  /**
   * Armed by a proven link's packet and run out one keepalive later: a timer rather than a read
   * of the clock, so a wall clock stepping backwards cannot keep a dead radio "carrying".
   */
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const forget = (): void => {
    clearTimeout(quiet);
    quiet = undefined;
  };
  return {
    /** The link deadline, noting a proven link's packet as it re-arms the link's own. */
    watching: <L extends { readonly heard: (hint: string) => void }>(liveness: L): L => ({
      ...liveness,
      heard: (hint: string): void => {
        liveness.heard(hint);
        if (!proven.has(hint)) return;
        clearTimeout(quiet);
        quiet = setTimeout(forget, everyMs);
      },
    }),
    /** Heard inside one keepalive, and some proven link is still held to have heard it on. */
    recently: (): boolean => quiet !== undefined && proven.size > 0,
    /** The radio stopped: whatever it carried, it carries nothing now. */
    forget,
  };
};
