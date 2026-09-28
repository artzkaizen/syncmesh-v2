/**
 * Whether the origin's mesh is reaching its relay, told to every window of it.
 *
 * **Not over the mesh port, and the omission is the argument.** `FollowerMesh` deliberately has no
 * `transports`: a window is not a device, and a radio toggled in tab three is the *origin's* radio.
 * That reasoning holds here — which is why this is a fact broadcast to every window rather than a
 * surface a window can act on. A `BroadcastChannel` is the right shape for exactly that: the
 * worker that holds the engine says it once, and the leader's tab, the follower's tab and a tab
 * opened a minute later all hear the same sentence.
 *
 * A tab that arrives late would otherwise hear nothing until the next change, so the channel
 * carries an ask as well as a tell, and the worker answers it with what it last said.
 */

/** Where this device stands with its relay. */
export type Reaching =
  /** No relay is configured in this build: the app is local-only and says so rather than pretending. */
  | "off"
  /** Dialling, and nothing has come back yet — the first second of a boot, and no longer. */
  | "reaching"
  /** A relay answered the join and is carrying. */
  | "online"
  /** Configured, dialled, and refused or unanswered. The demo's "start the relay" state. */
  | "unreachable";

export interface Reach {
  readonly state: Reaching;
  /**
   * This install's device, whole.
   *
   * It rides with the relay's state because the two questions are asked together: *are these two
   * browsers talking*, and *are they actually two devices*. One install presenting the other's
   * peer id is the failure this whole change exists to prevent, and a person can see it here
   * without opening a panel.
   */
  readonly device: string;
  /** The relay this build dials; absent when none is configured. */
  readonly url?: string;
  /** The last link-level ending in the transport's own words — "could not reach ws://…". */
  readonly why?: string;
}

/** One origin, one channel. A second app in this origin would name a second one, as D07 does. */
const CHANNEL = "issues:reach";

/** An arriving window asking for the current state, or the worker stating it. */
type Told = { readonly ask: true } | { readonly tell: Reach };

/**
 * The worker's end: says the state now, and again to whoever asks later.
 *
 * Held open for the life of the worker rather than per announcement, because a channel closed
 * between two announcements would miss the ask that arrived in the gap.
 */
export function serveReach(): (reach: Reach) => void {
  const channel = new BroadcastChannel(CHANNEL);
  let said: Reach | undefined;
  channel.onmessage = (event) => {
    // SAFETY: the only other end of this channel is `watchReach` in this same bundle
    const message = event.data as Told;
    if ("ask" in message && said !== undefined) channel.postMessage({ tell: said });
  };
  return (reach) => {
    said = reach;
    channel.postMessage({ tell: reach });
  };
}

/** A window's end: the state as it changes, starting with whatever the worker last said. */
export function watchReach(listener: (reach: Reach) => void): () => void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => {
    // SAFETY: the only other end of this channel is `serveReach` in this same bundle
    const message = event.data as Told;
    if ("tell" in message) listener(message.tell);
  };
  channel.postMessage({ ask: true });
  return () => channel.close();
}
