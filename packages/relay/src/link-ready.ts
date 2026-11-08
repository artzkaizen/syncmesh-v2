import { durationMs, type Temporal } from "@syncmesh/temporal";

/**
 * The two promises a relay link answers with, kept apart because they are two questions:
 * {@link Transport.whenReady} is answered by a hello, {@link Transport.caughtUp} by the last page
 * of a catch-up. Both force-resolve at the deadline {@link LinkReady.arm} sets, so a relay that
 * never speaks is never the one that wedges the mesh.
 */
export interface LinkReady {
  /** Starts a fresh wait for the hello, and the deadline that ends both waits. */
  readonly arm: (forceAfter: Temporal.Duration) => void;
  /** The relay said hello. */
  readonly hello: () => void;
  /** The last page of a catch-up arrived. */
  readonly lastPage: () => void;
  /**
   * A session dropped before it finished: a session that dropped mid-catch-up has not finished
   * its pass, and answering otherwise would let an app draw an empty state over a half-delivered
   * room.
   */
  readonly rearmLastPage: () => void;
  readonly whenReady: () => Promise<void>;
  readonly caughtUp: () => Promise<void>;
}

/** Both waits unresolved and no deadline armed, as a link is before `start`. */
export function createLinkReady(): LinkReady {
  let helloResolve = (): void => undefined;
  let ready = new Promise<void>((resolve) => (helloResolve = resolve));
  let forced = Promise.resolve();
  let lastPageResolve = (): void => undefined;
  let lastPage = new Promise<void>((resolve) => (lastPageResolve = resolve));
  return {
    arm: (forceAfter) => {
      const hello = new Promise<void>((resolve) => (helloResolve = resolve));
      forced = new Promise<void>((resolve) => setTimeout(resolve, durationMs(forceAfter)));
      ready = Promise.race([hello, forced]);
    },
    hello: () => helloResolve(),
    lastPage: () => lastPageResolve(),
    rearmLastPage: () => {
      lastPage = new Promise<void>((resolve) => (lastPageResolve = resolve));
    },
    whenReady: () => ready,
    caughtUp: () => Promise.race([lastPage, forced]),
  };
}
