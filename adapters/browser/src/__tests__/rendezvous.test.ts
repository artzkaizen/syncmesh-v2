import { describe, expect, test } from "bun:test";

import type { ConnectScope } from "../broker.js";
import type { CarrierPort } from "../rendezvous.js";

import { broker } from "../broker.js";
import { rendezvousOver } from "../rendezvous.js";
import { settle } from "./origin.js";

/** A rendezvous and the tabs connected to it, each holding the client end of a real channel. */
const bus = () => {
  const gate = new MessageChannel();
  const shared: ConnectScope = { onconnect: null };
  broker(shared);
  gate.port2.onmessage = (event) => shared.onconnect?.(event);
  return () => {
    const wire = new MessageChannel();
    gate.port1.postMessage("connect", [wire.port2]);
    const port: CarrierPort = wire.port1;
    const rendezvous = rendezvousOver(port);
    const served: MessagePort[] = [];
    let turnovers = 0;
    rendezvous.onServe((given) => void served.push(given));
    rendezvous.onTurnover(() => {
      turnovers += 1;
    });
    return {
      rendezvous,
      served,
      turnovers: () => turnovers,
    };
  };
};

/** Answers with `who` so a seeker can prove which tab's worker it actually reached. */
const answer = (port: MessagePort, id: string) => {
  port.onmessage = () => port.postMessage(id);
};

const ask = (port: MessagePort) =>
  new Promise<string>((resolve) => {
    port.onmessage = (event) => resolve(event.data);
    port.postMessage("who");
  });

describe("the rendezvous", () => {
  test("brokers a follower's port to the tab that claimed the host role", async () => {
    const join = bus();
    const host = join();
    const follower = join();
    await host.rendezvous.announce();

    const wire = new MessageChannel();
    follower.rendezvous.seek(wire.port1);
    await settle();

    expect(host.served).toHaveLength(1);
    answer(host.served[0]!, "leader");
    expect(await ask(wire.port2)).toBe("leader");
  });

  test("a port sought with no host waits rather than failing, and is served on the next claim", async () => {
    const join = bus();
    const orphan = join();
    const wire = new MessageChannel();

    orphan.rendezvous.seek(wire.port1);
    await settle();

    const host = join();
    await host.rendezvous.announce();
    await settle();

    expect(host.served).toHaveLength(1);
    answer(host.served[0]!, "late");
    expect(await ask(wire.port2)).toBe("late");
  });

  test("a new host turns over every other tab and not itself", async () => {
    const join = bus();
    const first = join();
    const follower = join();
    await first.rendezvous.announce();
    await settle();

    const second = join();
    await second.rendezvous.announce();
    await settle();

    expect(second.turnovers()).toBe(0);
    expect(follower.turnovers()).toBe(1);
    expect(first.turnovers()).toBe(1);
  });

  test("the host leaving turns over the rest without waiting for a successor", async () => {
    const join = bus();
    const host = join();
    const follower = join();
    await host.rendezvous.announce();
    await settle();

    host.rendezvous.leave();
    await settle();

    expect(follower.turnovers()).toBe(1);
  });

  test("a follower leaving turns over nobody", async () => {
    const join = bus();
    const host = join();
    const follower = join();
    const other = join();
    await host.rendezvous.announce();
    await settle();

    follower.rendezvous.leave();
    await settle();

    expect(other.turnovers()).toBe(0);
    expect(host.turnovers()).toBe(0);
  });
});
