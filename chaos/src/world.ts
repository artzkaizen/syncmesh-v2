import type { RelayDial } from "@syncmesh/relay";
import type { Transport } from "@syncmesh/transport";

import { bleTransport } from "@syncmesh/ble";
import { virtualAir, type VirtualAir } from "@syncmesh/ble/testing";
import { createMesh } from "@syncmesh/client";
import { parsePartitionKey } from "@syncmesh/kernel";
import { relayTransport, startRelay } from "@syncmesh/relay";
import { panic } from "@syncmesh/result";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";

import type { Ledger } from "./ledger.js";

import { short } from "./ledger.js";
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
 * By default grants are handed out at boot rather than propagated: grant distribution is its own
 * failure and a run that loses one loses everything after it. `grants: "fault"` is that run —
 * device `a` holds the issuer key, and some devices are granted only mid-run, by `a`, with every
 * peer learning the grant through sync.
 */

const SERVICE_UUID = "6b1d0001-8f2a-4c3e-9f1b-2a7c5d8e0f31";
const CHARACTERISTIC_UUID = "6b1d0002-8f2a-4c3e-9f1b-2a7c5d8e0f31";

/** Which links a device was built with. A device with neither is one that can only talk to itself. */
export interface Wiring {
  readonly relay: boolean;
  readonly ble: boolean;
}

/** The schedule switches that change how the world is built. All off is the original run. */
export interface Switches {
  /** `boot`: every grant registered everywhere before the first write. `fault`: some issued mid-run. */
  readonly grants: "boot" | "fault";
  /** Devices attach blobs to rows mid-fault; every device must read every one back after heal. */
  readonly blobs: boolean;
  /** Devices compact mid-run, the relay trims, and one device sleeps past the floor. */
  readonly retention: boolean;
}

export const NO_SWITCHES = {
  grants: "boot",
  blobs: false,
  retention: false,
} as const satisfies Switches;

/** How long the relay keeps an event under `retention`: short enough that a sleeper falls below it. */
const KEEP_EVENTS = Temporal.Duration.from({ milliseconds: 400 });
const SWEEP_EVERY = Temporal.Duration.from({ milliseconds: 100 });
const VALID_FOR = Temporal.Duration.from({ hours: 4 });

export interface WorldOptions {
  readonly devices: readonly Wiring[];
  readonly switches: Switches;
  readonly ledger: Ledger;
  readonly dir: string;
  /** Seeded, so the packet lost at the awkward moment is lost again on replay. */
  readonly random: () => number;
}

/** The close reasons the relay sends with a typed refusal (`connection.ts`'s `refuse`). */
const REFUSALS = new Set(["retention", "version"]);

/**
 * `webSocketDial`, with the close reason kept.
 *
 * The relay refuses a joiner below its retention floor with a typed `error` frame and closes
 * the socket with the code as its reason. On a sealed link the frame is not readable from here,
 * and the library's dial drops the reason, so the transport reconnects without anything above it
 * learning it was refused. This copy differs only in handing that reason to `onRefused`, so the
 * ledger can record the refusal the device was given.
 */
const reasonDial = (url: string, onRefused: (code: string) => void) => (): Promise<RelayDial> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const frames = new Set<(frame: Uint8Array) => void>();
    const closes = new Set<() => void>();
    const early: Uint8Array[] = [];
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve({
        send: (frame) => {
          if (ws.readyState !== WebSocket.OPEN) throw new Error("relay socket is not open");
          // SAFETY: every frame reaching here was built by `@syncmesh/relay` over a plain `ArrayBuffer`
          ws.send(frame as Uint8Array<ArrayBuffer>);
        },
        onFrame: (cb) => {
          frames.add(cb);
          for (const bytes of early.splice(0)) cb(bytes);
          return () => void frames.delete(cb);
        },
        onClose: (cb) => {
          closes.add(cb);
          return () => void closes.delete(cb);
        },
        close: () => ws.close(),
      });
    };
    ws.onerror = () => {
      if (!opened) reject(new Error(`could not reach ${url}`));
    };
    ws.onmessage = (message) => {
      if (!(message.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(message.data);
      if (frames.size === 0) early.push(bytes);
      else for (const cb of frames) cb(bytes);
    };
    ws.onclose = (event) => {
      if (REFUSALS.has(event.reason)) onRefused(event.reason);
      for (const cb of closes) cb();
    };
  });

/**
 * A relay link that can be cut.
 *
 * `relayTransport` reconnects on its own, which is the behaviour under test — so taking the link
 * down means refusing the dial rather than reaching inside the transport. The socket already open
 * is closed too, or the transport keeps using a link the schedule believes is gone.
 */
const cuttableDial = (url: string, onRefused: (code: string) => void) => {
  const open = new Set<{ readonly close: () => void }>();
  let up = true;
  const dial = async (): Promise<RelayDial> => {
    if (!up) throw new Error("relay unreachable");
    const dialed = await reasonDial(url, onRefused)();
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
  const { devices: wirings, switches, ledger, dir, random } = options;
  const identities = wirings.map((_, index) =>
    createIdentity(Uint8Array.from({ length: 32 }, (_, i) => index * 7 + i + 1)).unwrap(),
  );
  // under `grants: "fault"` the issuer is device `a` itself, so a grant minted mid-run leaves
  // through a real mesh and its real links rather than appearing everywhere at once
  const issuer =
    switches.grants === "fault" && identities[0] !== undefined
      ? identities[0]
      : createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
  const partition = parsePartitionKey(WORKSPACE).unwrap();
  const relayOptions = { dataDir: `${dir}/relay`, keepaliveMs: 60_000 };
  if (switches.retention)
    Object.assign(relayOptions, {
      retention: { keepEventsFor: KEEP_EVENTS, sweepEvery: SWEEP_EVERY },
    });
  const relay = await startRelay(0, relayOptions);
  const air = virtualAir(185, { random });
  const room = "chaos";

  const built = await Promise.all(
    wirings.map(async (wiring, index) => {
      const name = String.fromCharCode(97 + index);
      const identity = identities[index] ?? panic(`no identity for device ${name}`);
      const link = cuttableDial(`ws://localhost:${relay.port}/${room}`, (code) =>
        ledger.write({
          kind: "refused",
          device: name,
          transport: "relay",
          code,
          message: "the relay closed this link with a typed refusal",
        }),
      );
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
      const meshOptions = {
        schema: chaosSchema(),
        identity,
        issuer: issuer.peerId,
        driver,
        transports,
      };
      // only the issuer's own device can mint, and only under `grants: "fault"` is it a device
      if (identity === issuer) Object.assign(meshOptions, { issuerKey: issuer });
      const mesh = (await createMesh(meshOptions)).unwrap();

      // what each medium says about its own links — a refusal at the door, a session replaced
      mesh.transports.onLinkEvent((event) =>
        ledger.write({
          kind: "medium",
          device: name,
          transport: event.transport,
          event: event.kind,
          peer: event.peer === undefined ? "" : short(event.peer),
          why: event.why ?? "",
        }),
      );
      mesh.engine.onQuarantine(({ event, reason }) =>
        ledger.write({
          kind: "quarantined",
          device: name,
          author: event.peerId.slice(0, 8),
          seqNum: event.seqNum,
          reason: reason.message,
        }),
      );
      mesh.engine.onFoldBatch((batch) => {
        ledger.write({
          kind: "folded",
          device: name,
          count: batch.eventCount,
          source: batch.source,
        });
        // state taken without its events: what the device now claims, for the invariant to read
        if (batch.source === "snapshot")
          ledger.write({
            kind: "covered",
            device: name,
            source: batch.source,
            cursors: Object.fromEntries(mesh.engine.coverage().synced),
          });
      });

      return { name, index, identity, mesh, link, driver, wiring, partition };
    }),
  );

  // under `grants: "fault"`, some devices other than the issuer start with no grant anywhere —
  // not even their own — and are granted mid-run by `grant` below
  const late =
    switches.grants === "fault" ? built.filter((device) => device.index > 0 && random() < 0.4) : [];
  const fallback = built.at(-1);
  if (switches.grants === "fault" && late.length === 0 && fallback !== undefined)
    late.push(fallback);

  // every early device knows every early device: provisioned at boot, out of band
  const wires = built
    .filter((device) => !late.includes(device))
    .map((device) =>
      issueGrant(issuer, {
        account: `acct_${device.name}`,
        device: device.identity.peerId,
        role: "member",
        partitions: [partition],
        validFor: VALID_FOR,
        // the wall clock, not a fixture instant: these grants are checked against the real `now`
        // the mesh reads, and a fixed one expires the moment the calendar passes it
        now: Temporal.Now.instant(),
      }),
    );
  for (const device of built) for (const wire of wires) device.mesh.grants.register(wire).unwrap();

  const authority = built[0];

  /**
   * The issuer mints `device`'s grant on its own mesh and answers the device directly — the
   * reply to its grant request. Every other peer learns it the way grants travel: the issuer's
   * links send it on registration, the relay forwards it, and each receiver's links pass it on.
   */
  const grant = (device: (typeof built)[number]) =>
    (authority ?? panic("a world has at least one device")).mesh.grants
      .issue({
        account: `acct_${device.name}`,
        device: device.identity.peerId,
        role: "member",
        partitions: [WORKSPACE],
        validFor: VALID_FOR,
      })
      .andThen((wire) => device.mesh.grants.register(wire));

  return {
    devices: built,
    air,
    table: NOTE,
    partition,
    /** Devices still waiting for a grant under `grants: "fault"`; empty otherwise. */
    late,
    grant,
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
