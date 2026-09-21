import type { ByteStream, Unsubscribe } from "@syncmesh/transport";

import { TaggedError } from "@syncmesh/result";

/**
 * One connection a native module opened, as the `ByteStream` the upgrader reads.
 *
 * The platform hands over a handle and then talks about it in events; this is the object that
 * turns those two halves back into a stream. Everything subtle here is a promise a real socket
 * keeps for free and a bridged one has to be written to keep: ordering across the gap before a
 * reader attaches, a close that is visible to both sides, a write that fails loudly, and a queue
 * that cannot grow until the process dies.
 *
 * **Shared by every medium that crosses the bridge**, which is why it sits here rather than under
 * one of them: a Wi-Fi Aware data path, an AWDL link and a TCP socket on a LAN are the same shape
 * once a native module is in the middle, and three copies of this would be three chances to get
 * the pre-reader gap wrong.
 */

/** A connection that ended, or bytes that did not leave. Ordinary on any of these media. */
export class NativeStreamFailed extends TaggedError("NativeStreamFailed")<{
  message: string;
}> {}

/** What the native side needs to be asked, for one path. */
export interface PathIo {
  /** Resolves when the bytes left the radio, and rejects when they did not. */
  readonly send: (bytes: Uint8Array) => Promise<void>;
  /**
   * Lets the far end's bytes through, once.
   *
   * **The platform cannot be told by a listener count.** Expo's `OnStartObserving` is installed
   * by `ModuleDefinition` and never by `ClassDefinition`, so a per-stream native object has no
   * way to learn that JavaScript attached its first reader — a module that waited for one would
   * wait for ever and read as a dead peer. So the stream starts paused on the native side, holds
   * what arrives, and is let go explicitly the first time somebody reads.
   */
  readonly resume: () => void;
  /**
   * Ends the path at the platform **and tells the fabric to forget it**.
   *
   * Both halves, because a stream closed from above is one the platform may never mention again:
   * `closePath` is fire-and-forget and nothing requires a module to echo `onPathClosed`. A fabric
   * still holding the handle would route the next path that reuses it into this dead object.
   */
  readonly close: () => void;
}

/** A path, plus the two doors the fabric pushes platform events through. */
export interface Path {
  readonly stream: ByteStream;
  /** A chunk arrived from the far end. */
  readonly accept: (bytes: Uint8Array) => void;
  /** The platform said this path is over. Idempotent; the stream's own `close` goes here too. */
  readonly shut: () => void;
}

/**
 * How much a path holds for a reader that has not attached yet, and how much it queues for a
 * radio that has not drained.
 *
 * **Both are doors, not tuning knobs**, and they sit on the two sides `framing.ts`'s own cap
 * cannot reach. Below it: a peer nobody has authenticated writes into the gap before the framer
 * exists, and unbounded there means a stranger decides this process's memory. Above it: a bridge
 * accepts frames far faster than a duty-cycled radio emits them, and `ByteStream.write` has no
 * `false` to return — so the only honest backpressure available is to refuse, which the contract
 * explicitly permits.
 */
const HELD_BYTES = 1024 * 1024;
const QUEUED_BYTES = 4 * 1024 * 1024;

const drop = <T>(set: Set<T>, one: T): Unsubscribe => {
  set.add(one);
  return () => void set.delete(one);
};

export function pathOver(id: string, io: PathIo): Path {
  const readers = new Set<(bytes: Uint8Array) => void>();
  const closers = new Set<() => void>();
  /**
   * What arrived before anyone was reading.
   *
   * **A real socket starts paused for exactly this reason.** Accepting a path and attaching a
   * reader cannot be one step, and the peer's hello is already on its way — so a stream that
   * dropped what arrived in that gap would lose the handshake and then refuse everything after
   * it for the life of the link.
   */
  let waiting: Uint8Array[] = [];
  let held = 0;
  let closed = false;
  /** The first write that did not leave. Every later one is a lie until the path is rebuilt. */
  let failure: unknown;
  /** Writes are serialised: a radio is one pipe, and two frames racing it invites reordering. */
  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;

  const shut = (): void => {
    if (closed) return;
    closed = true;
    // whatever was still queued is not going anywhere, and a queued send would be calling the
    // platform about a handle it has already destroyed
    failure ??= new NativeStreamFailed({ message: `the path to ${id} closed` });
    waiting = [];
    held = 0;
    for (const cb of new Set(closers)) cb();
  };

  /**
   * Anything already waiting goes first.
   *
   * A chunk that arrived before there was a reader is older than one that arrives after, and
   * handing the newer one over first would deliver a peer's sealed frames ahead of the hello
   * that makes them readable — which the session cannot recover from, because what it dropped
   * is gone.
   */
  const arrive = (bytes: Uint8Array): void => {
    if (closed) return; // the far end has gone; nothing may arrive after that
    // copied, not referenced: delivery is deferred by at least a microtask, and a module that
    // hands over a window into a buffer it reuses would have overwritten it by then. Expo's own
    // `Data` conversion copies, so this is insurance against the next module rather than a fix
    // for that one — and it is one memcpy against a frame the radio will spend milliseconds on
    const chunk = Uint8Array.from(bytes);
    if (readers.size === 0 || waiting.length > 0) {
      held += chunk.length;
      if (held > HELD_BYTES) return shut(); // a stranger does not get to decide our memory
      waiting.push(chunk);
      return;
    }
    for (const cb of [...readers]) cb(chunk);
  };

  /** Indexed rather than shifted: a backlog drained with `shift()` is quadratic in its length. */
  const drain = (): void => {
    let at = 0;
    while (at < waiting.length && readers.size > 0 && !closed) {
      const chunk = waiting[at];
      at += 1;
      if (chunk !== undefined) for (const cb of [...readers]) cb(chunk);
    }
    waiting = waiting.slice(at);
    held = waiting.reduce((sum, one) => sum + one.length, 0);
  };

  const stream: ByteStream = {
    /**
     * **Throws when the bytes did not leave**, which is the contract the bridge is built on: a
     * loud failure ends the link and resyncs from cursors, a silent one leaves two devices
     * believing different things.
     *
     * The platform's send is asynchronous and this is not, so a failure cannot be reported on the
     * call that caused it — and a rejection poisons the chain, so every write already queued
     * behind it never leaves either. What bounds that is `QUEUED_BYTES`: the writer is refused
     * before it can pile up more than one radio-drain's worth of frames, so the bytes lost to a
     * failure this cannot report are bounded rather than "however many the caller managed".
     */
    write: (bytes) => {
      if (failure !== undefined)
        throw new NativeStreamFailed({ message: `the path to ${id} is down` });
      if (closed) throw new NativeStreamFailed({ message: `the path to ${id} is closed` });
      if (queued + bytes.length > QUEUED_BYTES)
        throw new NativeStreamFailed({ message: `the radio is behind on the path to ${id}` });
      queued += bytes.length;
      queue = queue.then(async () => {
        // the close may have landed while this was waiting its turn
        if (closed) return;
        await io.send(bytes);
        queued -= bytes.length;
      });
      void queue.then(undefined, (cause: unknown) => {
        if (failure !== undefined) return;
        failure = cause;
        shut();
      });
    },
    onData: (cb) => {
      const first = readers.size === 0;
      const off = drop(readers, cb);
      // the platform is holding its own backlog until it is told somebody is reading; see
      // `PathIo.resume` for why a listener count cannot tell it
      if (first) io.resume();
      // on a microtask, not here: delivering inside the subscribe call would reach whoever was
      // mid-construction and nobody above them
      if (waiting.length > 0) void Promise.resolve().then(drain);
      return off;
    },
    /** Fires now for a path that is already over: a listener attached late still hears it once. */
    onClose: (cb) => {
      if (closed) {
        cb();
        return () => undefined;
      }
      return drop(closers, cb);
    },
    close: () => {
      io.close();
      shut();
    },
  };

  return { accept: arrive, shut, stream };
}
