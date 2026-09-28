import type { ByteStream } from "@syncmesh/transport";

import { describe, expect, test } from "bun:test";

import type {
  RnLanAnnouncement,
  RnLanClosed,
  RnLanConnection,
  RnLanData,
  RnLanManager,
  RnLanSubscription,
} from "../lan/rn-lan.js";

import { lanFrom } from "../lan/rn-lan.js";

/**
 * The seam between a networking module and the LAN port, tested with no socket.
 *
 * The two halves fail differently, so both are here: an announcement is a datagram, cheap and
 * lossy and repeated, where the only real hazard is saying something untrue; a stream must not
 * lose a byte, which is the same contract every other bridged medium in this package keeps.
 */

/** The module's events, paired with their payloads so a wrong shape fails to compile. */
type Emitted =
  | readonly ["onAnnouncement", RnLanAnnouncement]
  | readonly ["onLanClosed", RnLanClosed]
  | readonly ["onLanConnection", RnLanConnection]
  | readonly ["onLanData", RnLanData];

const fake = (supports = true) => {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const announced: Uint8Array[] = [];
  const dialled: { host: string; port: number }[] = [];
  let started: { group: string; port: number } | undefined;
  let gives = 4321;

  const manager: RnLanManager = {
    addListener: (event, cb): RnLanSubscription => {
      const held = listeners.get(event) ?? new Set();
      held.add(cb);
      listeners.set(event, held);
      return { remove: () => void held.delete(cb) };
    },
    announce: (bytes) => void announced.push(bytes),
    closePath: () => undefined,
    dial: (host, port) => {
      dialled.push({ host, port });
      return Promise.resolve("sock-1");
    },
    resume: () => undefined,
    send: () => Promise.resolve(),
    start: (group, groupPort) => {
      started = { group, port: groupPort };
      return Promise.resolve(gives);
    },
    stop: () => Promise.resolve(),
    supports: () => supports,
  };

  return {
    announced,
    dialled,
    emit: (...[event, payload]: Emitted) => {
      for (const cb of listeners.get(event) ?? []) {
        // SAFETY: `Emitted` pairs each event with the payload `rn-lan.ts` declares for it; the
        // port types the callback as `never` because it will not guess, and the fake is the side
        // that knows — that is the whole job of a stand-in for a native module
        (cb as (one: typeof payload) => void)(payload);
      }
    },
    listensOn: () => started,
    manager,
    startsWith: (port: number) => void (gives = port),
  };
};

const settle = () => new Promise((done) => setTimeout(done, 0));
const bytes = (...of: number[]) => Uint8Array.from(of);

describe("a networking module as a LAN", () => {
  test("a build with no sockets is refused here, not discovered later", () => {
    const refused = lanFrom(fake(false).manager);
    expect(refused.isErr() && refused.error._tag).toBe("LanUnsupported");
  });

  test("it joins the transport's own group unless told another", async () => {
    const rn = fake();
    lanFrom(rn.manager).unwrap();
    await settle();
    // the administratively-scoped range routers are required not to forward off the local network
    expect(rn.listensOn()).toEqual({ group: "239.255.71.67", port: 47_167 });
  });

  /**
   * The hazard this port has and the radios do not.
   *
   * The transport builds every announcement from `address().port`, and the listener's port is not
   * known until the module answers. An announcement carrying zero is not a harmless early beat —
   * it tells every peer in the room to dial nowhere, records a sighting, and spends a dial
   * against it. Announcements repeat, so silence costs one beat and a lie costs a peer.
   */
  test("nothing is announced before the listener has a port", async () => {
    const rn = fake();
    const held: string[] = [];
    const lan = lanFrom(rn.manager, { onDropped: (why) => void held.push(why) }).unwrap();

    lan.network.announce(bytes(1));
    expect(rn.announced).toEqual([]);
    expect(lan.network.address().port).toBe(0);
    expect(held).toHaveLength(1);

    await settle();
    expect(lan.network.address().port).toBe(4321);
    lan.network.announce(bytes(1));
    expect(rn.announced).toEqual([bytes(1)]);
  });

  test("an announcement is reported with where the datagram actually came from", async () => {
    const rn = fake();
    const lan = lanFrom(rn.manager).unwrap();
    const heard: { bytes: number[]; host: string; port: number }[] = [];
    lan.network.onAnnouncement(
      (payload, from) => void heard.push({ bytes: [...payload], host: from.host, port: from.port }),
    );
    rn.emit("onAnnouncement", { bytes: bytes(7), host: "192.168.2.9", port: 47_167 });
    // the source address, not what the announcement claimed — one of the two is cheap to forge
    expect(heard).toEqual([{ bytes: [7], host: "192.168.2.9", port: 47_167 }]);
    await settle();
  });

  test("a dial goes to the address it was given and comes back as a stream", async () => {
    const rn = fake();
    const lan = lanFrom(rn.manager).unwrap();
    await settle();
    const stream = await lan.network.dial({ host: "192.168.2.9", port: 5000 });
    expect(rn.dialled).toEqual([{ host: "192.168.2.9", port: 5000 }]);

    const got: number[][] = [];
    stream.onData((chunk) => void got.push([...chunk]));
    rn.emit("onLanData", { bytes: bytes(3), path: "sock-1" });
    await settle();
    expect(got).toEqual([[3]]);
  });

  test("an accepted socket delivers what arrived before anyone read it", async () => {
    const rn = fake();
    const lan = lanFrom(rn.manager).unwrap();
    let accepted: ByteStream | undefined;
    lan.network.onConnection((stream) => void (accepted = stream));
    rn.emit("onLanConnection", { host: "192.168.2.9", path: "sock-2", port: 5000 });
    if (accepted === undefined) throw new Error("the network never reported the socket");

    // the peer's hello is already in flight when a socket is accepted
    rn.emit("onLanData", { bytes: bytes(1), path: "sock-2" });
    const got: number[][] = [];
    accepted.onData((chunk) => void got.push([...chunk]));
    await settle();
    expect(got).toEqual([[1]]);
  });

  test("closing the network ends its sockets and forgets its port", async () => {
    const rn = fake();
    const lan = lanFrom(rn.manager).unwrap();
    await settle();
    expect(lan.network.address().port).toBe(4321);

    let shut = false;
    lan.network.onConnection((stream) => void stream.onClose(() => void (shut = true)));
    rn.emit("onLanConnection", { host: "192.168.2.9", path: "sock-3", port: 5000 });
    await lan.network.close();
    expect(shut).toBe(true);
    // and it says so rather than announcing a port it no longer listens on
    expect(lan.network.address().port).toBe(0);
  });
});
