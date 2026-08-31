import type { RelayDial } from "@syncmesh/relay";
import type { Transport } from "@syncmesh/transport";

import { bleTransport } from "@syncmesh/ble";
import { virtualAir, type VirtualAir } from "@syncmesh/ble/testing";
import { createMesh } from "@syncmesh/client";
import { parsePartitionKey } from "@syncmesh/kernel";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";

import type { Ledger } from "./ledger.js";

import { chaosSchema, NOTE, WORKSPACE } from "./schema.js";

/**
 * A mesh of devices that can actually be broken.
 *
 * Every part under test here is the real one: a real relay over a real socket, the real relay
 * transport with its own reconnect, and the real BLE transport — dial rule, fragmenting, session
 * handshake — over the same virtual air the `@syncmesh/ble` unit tests run against. What is faked
 * is only the radio hardware and the network's willingness to carry a packet, because those are
 * the two things a test has to be able to take away.
 *
 * Grants are handed out at boot rather than propagated. Grant distribution is its own failure and
 * a run that loses one loses everything after it, which would tell us nothing about whether events
 * survive: it is a separate switch, worth its own run once this one is quiet.
 */

const SERVICE_UUID = "6b1d0001-8f2a-4c3e-9f1b-2a7c5d8e0f31";
const CHARACTERISTIC_UUID = "6b1d0002-8f2a-4c3e-9f1b-2a7c5d8e0f31";

/** Which links a device was built with. A device with neither is one that can only talk to itself. */
export interface Wiring {
  readonly relay: boolean;
  readonly ble: boolean;
}

export interface WorldOptions {
  readonly devices: readonly Wiring[];
  readonly ledger: Ledger;
  readonly dir: string;
  /** Seeded, so the packet lost at the awkward moment is lost again on replay. */
  readonly random: () => number;
}

/**
 * A relay link that can be cut.
 *
 * `relayTransport` reconnects on its own, which is the behaviour under test — so taking the link
 * down means refusing the dial rather than reaching inside the transport. The socket already open
 * is closed too, or the transport keeps using a link the schedule believes is gone.
 */
const cuttableDial = (url: string) => {
  const open = new Set<{ readonly close: () => void }>();
  let up = true;
  const dial = async (): Promise<RelayDial> => {
    if (!up) throw new Error("relay unreachable");
    const dialed = await webSocketDial(url)();
    open.add(dialed);
    return dialed;
  };
  return {
    dial,
    set: (next: boolean) => {
      up = next;
      if (next) return;
      for (const dialed of open) dialed.close();
      open.clear();
    },
  };
};

export async function createWorld(options: WorldOptions) {
  const { devices: wirings, ledger, dir, random } = options;
  const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
  const partition = parsePartitionKey(WORKSPACE).unwrap();
  const relay = await startRelay(0, { dataDir: `${dir}/relay`, keepaliveMs: 60_000 });
  const air = virtualAir(185, { random });
  const room = "chaos";

  const built = await Promise.all(
    wirings.map(async (wiring, index) => {
      const name = String.fromCharCode(97 + index);
      const identity = createIdentity(
        Uint8Array.from({ length: 32 }, (_, i) => index * 7 + i + 1),
      ).unwrap();
      const link = cuttableDial(`ws://localhost:${relay.port}/${room}`);
      const transports: Transport[] = [];
      if (wiring.relay) transports.push(relayTransport({ dial: link.dial }));
      if (wiring.ble)
        transports.push(
          bleTransport({
            radio: air.radioFor(name),
            serviceUuid: SERVICE_UUID,
            characteristicUuid: CHARACTERISTIC_UUID,
            name: "nearby",
          }),
        );

      const driver = bunSqliteDriver(`${dir}/${name}.db`);
      const mesh = (
        await createMesh({
          schema: chaosSchema(),
          identity,
          issuer: issuer.peerId,
          driver,
          transports,
        })
      ).unwrap();

      mesh.engine.onQuarantine(({ event, reason }) =>
        ledger.write({
          kind: "quarantined",
          device: name,
          author: event.peerId.slice(0, 8),
          seqNum: event.seqNum,
          reason: reason.message,
        }),
      );
      mesh.engine.onFoldBatch((batch) =>
        ledger.write({
          kind: "folded",
          device: name,
          count: batch.eventCount,
          source: batch.source,
        }),
      );

      return { name, index, identity, mesh, link, driver, wiring, partition };
    }),
  );

  // every device knows every device: see the note above about grants being a separate run
  const wires = built.map((device) =>
    issueGrant(issuer, {
      account: `acct_${device.name}`,
      device: device.identity.peerId,
      role: "member",
      partitions: [partition],
      validFor: Temporal.Duration.from({ hours: 4 }),
      // the wall clock, not a fixture instant: these grants are checked against the real `now`
      // the mesh reads, and a fixed one expires the moment the calendar passes it
      now: Temporal.Now.instant(),
    }),
  );
  for (const device of built) for (const wire of wires) device.mesh.grants.register(wire).unwrap();

  return {
    devices: built,
    air,
    table: NOTE,
    partition,
    stop: async () => {
      for (const device of built) {
        await device.mesh.stop();
        await device.driver.close?.();
      }
      await relay.stop();
    },
  };
}

export type World = Awaited<ReturnType<typeof createWorld>>;
export type Device = World["devices"][number];
export type { VirtualAir };
