import type { ByteStream } from "@syncmesh/transport";

import { describe, expect, test } from "bun:test";

import type {
  RnP2pClosed,
  RnP2pData,
  RnP2pFound,
  RnP2pLost,
  RnP2pManager,
  RnP2pPath,
  RnP2pSubscription,
} from "../p2p/rn-p2p.js";

import { fabricFrom } from "../p2p/rn-p2p.js";

/**
 * The module's events, as a union of (name, payload) pairs.
 *
 * A union rather than a loose `emit(name, payload)`, so a test that writes the *port's* shape by
 * mistake — a bare peer id where the module sends `{ protocol, id }` — fails to compile instead
 * of passing. The two are close enough to look interchangeable and are not, which is the whole
 * reason this seam is written down.
 */
type Emitted =
  | readonly ["onPath", RnP2pPath]
  | readonly ["onPathClosed", RnP2pClosed]
  | readonly ["onPathData", RnP2pData]
  | readonly ["onPeerFound", RnP2pFound]
  | readonly ["onPeerLost", RnP2pLost];

/**
 * The seam between a native module and the fabric, tested with no device.
 *
 * Every case here is a way the bridge can lose bytes that a real socket cannot, which is the
 * whole reason this layer is written rather than assumed: a socket delivers in order, holds what
 * arrives before a reader attaches, and fails loudly on a write that did not leave. A module
 * plus an event channel does none of those by itself.
 */

/** A stand-in for the Expo module, shaped like one rather than like the port. */
const fake = (supports: readonly string[] = ["awdl", "wifi-aware"]) => {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const sent: { path: string; bytes: Uint8Array }[] = [];
  const stopped: string[] = [];
  const closed: string[] = [];
  const resumed: string[] = [];
  let dialled: Promise<string> = Promise.resolve("path-1");
  let refuse: Error | undefined;
  let slowFirst: Promise<void> | undefined;

  const manager: RnP2pManager = {
    addListener: (event, cb): RnP2pSubscription => {
      const held = listeners.get(event) ?? new Set();
      held.add(cb);
      listeners.set(event, held);
      return { remove: () => void held.delete(cb) };
    },
    closePath: (path) => void closed.push(path),
    connect: () => dialled,
    resume: (path) => void resumed.push(path),
    publish: () => Promise.resolve(),
    send: (path, bytes) => {
      if (refuse !== undefined) return Promise.reject(refuse);
      // the first send can be made to settle late, so a queue that did *not* serialise would
      // record the writes in the wrong order and the test would see it
      const record = () => void sent.push({ bytes, path });
      if (slowFirst !== undefined) {
        const held = slowFirst;
        slowFirst = undefined;
        return held.then(record);
      }
      record();
      return Promise.resolve();
    },
    stop: (protocol) => {
      stopped.push(protocol);
      return Promise.resolve();
    },
    supports: (protocol) => supports.includes(protocol),
  };

  return {
    closed,
    resumed,
    emit: (...[event, payload]: Emitted) => {
      for (const cb of listeners.get(event) ?? []) {
        // SAFETY: `Emitted` pairs each event with the payload `rn-p2p.ts` declares for it, so a
        // listener registered under that name is one written to take this shape. The port types
        // the callback as `never` precisely because it will not guess; the fake is the side that
        // knows, which is the whole job of a stand-in for the native module.
        (cb as (one: typeof payload) => void)(payload);
      }
    },
    manager,
    refuses: (why: Error) => void (refuse = why),
    /** The next send settles only when `later` does — everything after it must still queue behind. */
    sendsSlowlyUntil: (later: Promise<void>) => void (slowFirst = later),
    resolvesDialWith: (later: Promise<string>) => void (dialled = later),
    sent,
    stopped,
  };
};

const settle = () => new Promise((done) => setTimeout(done, 0));
const bytes = (...of: number[]) => Uint8Array.from(of);

/**
 * The stream for a path the far end opened.
 *
 * A helper rather than a cast at each call site: `onPath` fires inside `emit`, so the stream is
 * always there by the time this returns, and the throw states that invariant instead of a
 * non-null assertion hiding it.
 */
const inboundPath = (
  rn: ReturnType<typeof fake>,
  fabric: { readonly onPath: (cb: (s: ByteStream, from: string) => void) => () => void },
  path = "path-1",
): ByteStream => {
  let held: ByteStream | undefined;
  fabric.onPath((stream) => void (held = stream));
  rn.emit("onPath", { from: "p1", path, protocol: "awdl" });
  if (held === undefined) throw new Error(`the fabric never reported ${path}`);
  return held;
};

/** Everything a stream delivered, in the order it arrived. */
const reading = (stream: ByteStream) => {
  const got: number[][] = [];
  stream.onData((chunk) => void got.push([...chunk]));
  return got;
};

describe("a native module as a fabric", () => {
  test("a protocol this device cannot speak is refused here, not discovered later", () => {
    const rn = fake(["awdl"]);
    expect(fabricFrom(rn.manager, "awdl").isOk()).toBe(true);
    const refused = fabricFrom(rn.manager, "wifi-aware");
    expect(refused.isErr() && refused.error._tag).toBe("P2pUnsupported");
  });

  test("two fabrics over one module do not hear each other", () => {
    const rn = fake();
    const awdl = fabricFrom(rn.manager, "awdl").unwrap().fabric;
    const aware = fabricFrom(rn.manager, "wifi-aware").unwrap().fabric;
    const heard: string[] = [];
    awdl.onPeerFound((peer) => void heard.push(`awdl:${peer.id}`));
    aware.onPeerFound((peer) => void heard.push(`aware:${peer.id}`));

    rn.emit("onPeerFound", { announces: bytes(1), id: "p1", protocol: "awdl" });
    rn.emit("onPeerFound", { announces: bytes(2), id: "p2", protocol: "wifi-aware" });
    // an AWDL iPhone and a Wi-Fi Aware Android in one room are two rooms
    expect(heard).toEqual(["awdl:p1", "aware:p2"]);
  });
});

describe("a path across the bridge", () => {
  test("bytes that arrived before a reader attached are delivered, oldest first", async () => {
    const rn = fake();
    const fabric = fabricFrom(rn.manager, "awdl").unwrap().fabric;
    const stream = inboundPath(rn, fabric);

    // the peer's hello is already on its way when the path opens
    rn.emit("onPathData", { bytes: bytes(1), path: "path-1", protocol: "awdl" });
    rn.emit("onPathData", { bytes: bytes(2), path: "path-1", protocol: "awdl" });
    const got = reading(stream);
    expect(got).toEqual([]); // nothing before the reader — and nothing lost either
    await settle();
    expect(got).toEqual([[1], [2]]);
  });

  /**
   * The gap a dial has and an inbound path does not.
   *
   * `connect` learns its handle when the promise settles, and the platform starts reporting the
   * path the moment it opens — so the far end's hello can arrive before there is anything to
   * hand it to. Dropped, it costs the handshake and the link never recovers.
   */
  test("bytes that arrived before the dial resolved are not lost", async () => {
    const rn = fake();
    let handed: (id: string) => void = () => undefined;
    rn.resolvesDialWith(new Promise<string>((ok) => void (handed = ok)));
    const fabric = fabricFrom(rn.manager, "awdl").unwrap().fabric;

    const dialling = fabric.connect("p1");
    rn.emit("onPathData", { bytes: bytes(7), path: "path-1", protocol: "awdl" });
    handed("path-1");
    const got = reading(await dialling);
    await settle();
    expect(got).toEqual([[7]]);
  });

  test("a close that arrived before the dial resolved still closes the path", async () => {
    const rn = fake();
    let handed: (id: string) => void = () => undefined;
    rn.resolvesDialWith(new Promise<string>((ok) => void (handed = ok)));
    const fabric = fabricFrom(rn.manager, "awdl").unwrap().fabric;

    const dialling = fabric.connect("p1");
    rn.emit("onPathClosed", { path: "path-1", protocol: "awdl" });
    handed("path-1");
    const stream = await dialling;
    // a listener attached after the close still hears it once: the upgrader subscribes *after*
    // the fabric hands the stream over, so a close that only fired into an empty set is one the
    // transport never learns about — and it holds a dead link until liveness expires
    let shut = false;
    stream.onClose(() => void (shut = true));
    expect(shut).toBe(true);
    await settle();
    expect(() => stream.write(bytes(1))).toThrow();
  });

  test("a write that did not leave makes the path loud, not silent", async () => {
    const rn = fake();
    const fabric = fabricFrom(rn.manager, "awdl").unwrap().fabric;
    const stream = inboundPath(rn, fabric);

    let shut = false;
    stream.onClose(() => void (shut = true));
    rn.refuses(new Error("the radio went away"));
    stream.write(bytes(1)); // the failure is not known yet — this one cannot throw
    await settle();
    // but the path is over, and every write after it says so rather than pretending
    expect(shut).toBe(true);
    expect(() => stream.write(bytes(2))).toThrow();
  });

  /**
   * A radio is one pipe, and two frames racing it invites the stack to reorder them.
   *
   * The fake holds its *first* send open on purpose: with the writes serialised, nothing after it
   * may reach the module until it settles. A `void io.send(bytes)` with no chain would record
   * 2 and 3 first and this would fail — which the previous version of this test could not see,
   * because its fake resolved synchronously and could not reorder anything.
   */
  test("writes reach the module in the order they were made, not the order they settle", async () => {
    const rn = fake();
    const fabric = fabricFrom(rn.manager, "awdl").unwrap().fabric;
    const stream = inboundPath(rn, fabric);

    let release: () => void = () => undefined;
    rn.sendsSlowlyUntil(new Promise<void>((done) => void (release = () => done())));
    for (const n of [1, 2, 3]) stream.write(bytes(n));
    await settle();
    expect(rn.sent).toEqual([]); // all three are behind the first, which has not settled
    release();
    await settle();
    expect(rn.sent.map((one) => [...one.bytes])).toEqual([[1], [2], [3]]);
  });

  /**
   * The chunk that lands *between* a reader attaching and the backlog draining.
   *
   * This is the defect `transport-tests/channel.ts` names as one of two ever found in this layer:
   * deliver it straight through and the peer's sealed frames reach the session ahead of the hello
   * that makes them readable. Both earlier tests pass with the `waiting.length > 0` guard deleted;
   * this one does not.
   */
  test("a chunk arriving mid-drain still goes after the backlog", async () => {
    const rn = fake();
    const fabric = fabricFrom(rn.manager, "awdl").unwrap().fabric;
    const stream = inboundPath(rn, fabric);

    rn.emit("onPathData", { bytes: bytes(1), path: "path-1", protocol: "awdl" });
    rn.emit("onPathData", { bytes: bytes(2), path: "path-1", protocol: "awdl" });
    const got = reading(stream);
    // after the reader, before the drain microtask — the window the guard exists for
    rn.emit("onPathData", { bytes: bytes(3), path: "path-1", protocol: "awdl" });
    await settle();
    expect(got).toEqual([[1], [2], [3]]);
  });

  test("a reader is what lets the platform's own backlog go", async () => {
    const rn = fake();
    const fabric = fabricFrom(rn.manager, "awdl").unwrap().fabric;
    const stream = inboundPath(rn, fabric);
    // the native side holds its bytes until told somebody is reading; a listener count cannot
    // tell it, because Expo installs `OnStartObserving` on a module and never on a class
    expect(rn.resumed).toEqual([]);
    reading(stream);
    expect(rn.resumed).toEqual(["path-1"]);
  });

  test("closing a stream ends the path at the platform too, not just here", () => {
    const rn = fake();
    const fabric = fabricFrom(rn.manager, "awdl").unwrap().fabric;
    inboundPath(rn, fabric).close();
    // a path left open on the radio holds one of a handful of link slots for ever
    expect(rn.closed).toEqual(["path-1"]);
  });
});

describe("a radio that stops and comes back", () => {
  /**
   * `Transport.close()` calls `fabric.stop()`, and a restart — a radio that returned, a `wake()`
   * — runs the transport's `open` again over the **same fabric**. A `stop` that dropped this
   * fabric's own routing would leave that restarted transport publishing a service, opening
   * paths, and never hearing a byte on any of them.
   */
  test("stopping closes the paths without deafening the fabric", async () => {
    const rn = fake();
    const fabric = fabricFrom(rn.manager, "awdl").unwrap().fabric;
    const first = inboundPath(rn, fabric);

    let shut = false;
    first.onClose(() => void (shut = true));
    await fabric.stop();
    expect(shut).toBe(true);
    expect(rn.stopped).toEqual(["awdl"]);
    expect(rn.closed).toEqual(["path-1"]); // ended on the radio, not only in this process

    // and the same fabric, published again, still routes
    const second = inboundPath(rn, fabric, "path-2");
    rn.emit("onPathData", { bytes: bytes(9), path: "path-2", protocol: "awdl" });
    const got = reading(second);
    await settle();
    expect(got).toEqual([[9]]);
  });
});
