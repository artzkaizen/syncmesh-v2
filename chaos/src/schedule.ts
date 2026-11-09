import type { Procedure, TableName } from "@syncmesh/kernel";

import { eventStamp } from "@syncmesh/kernel";

import type { Ledger } from "./ledger.js";
import type { Outcome, SwitchState } from "./switches.js";
import type { Device, Switches, World } from "./world.js";

import { key as rowKey, row } from "./cells.js";
import { stampText } from "./ledger.js";
import { between, chance, pick } from "./random.js";
import { advertises, attach, beforeHeal, chooseSleeper, duringTick } from "./switches.js";

/**
 * The run itself: writes, and the faults that happen while they are being made.
 *
 * Every fault is one a device meets in the field, and the point of doing them at random *during*
 * writing rather than between rounds is that the interesting moment is always mid-flight. A link
 * that drops between two quiet phases proves nothing; one that drops with a page half-delivered is
 * the case that loses events.
 *
 * Nothing here decides what is correct. The schedule only makes things happen and says so in the
 * ledger; the oracle reads the ledger afterwards and works out what every device must hold.
 */

export interface Plan {
  readonly ticks: number;
  /** Writes attempted per tick, across the whole mesh. */
  readonly writesPerTick: number;
  /** Chance per tick that one device's relay link flips. */
  readonly relayFlip: number;
  /** Chance per tick that one device's radio range changes. */
  readonly reachFlip: number;
  /** Chance per tick that one device goes dark on every link at once, or comes back. */
  readonly darkFlip: number;
  /** Share of BLE packets that vanish while in flight. */
  readonly loss: number;
}

export const SMALL: Plan = {
  ticks: 20,
  writesPerTick: 1,
  relayFlip: 0.15,
  reachFlip: 0.15,
  darkFlip: 0.08,
  loss: 0.02,
};

// SAFETY: a literal this package owns; procedure naming rules arrive with the client, and nothing here takes one from outside
const WRITE = "chaos.write" as Procedure;

/** Rows have one owner for the whole run: two peers taking turns is a refusal, not a lost write. */
const ownerOf = (row: number, size: number) => row % size;

interface State extends SwitchState {
  /** Rows that exist, and the title last written to each — the schedule's own memory, not a claim. */
  readonly rows: Map<number, string>;
  /** Devices currently dark on every link. */
  readonly dark: Set<string>;
  readonly relayUp: Map<string, boolean>;
  readonly switches: Switches;
}

const setRelay = (device: Device, up: boolean, why: string, ledger: Ledger, state: State) => {
  if (!device.wiring.relay || state.relayUp.get(device.name) === up) return;
  state.relayUp.set(device.name, up);
  device.link.set(up);
  ledger.write({ kind: "link", device: device.name, transport: "relay", up, why });
  // the network came back: what a phone's reachability callback tells the mesh (`world.ts`)
  if (up) device.knock();
};

const setReach = (
  world: World,
  device: Device,
  reachable: readonly string[] | undefined,
  why: string,
  ledger: Ledger,
) => {
  if (!device.wiring.ble) return;
  world.air.setReach(device.name, reachable);
  ledger.write({
    kind: "link",
    device: device.name,
    transport: "ble",
    up: reachable === undefined || reachable.length > 0,
    why: `${why}: hears ${reachable === undefined ? "everyone" : reachable.join(",") || "nobody"}`,
  });
};

/** One tick's worth of things going wrong: a link flips, range changes, someone goes dark. */
function faults(
  world: World,
  plan: Plan,
  random: () => number,
  ledger: Ledger,
  state: State,
): void {
  if (chance(random, plan.relayFlip)) {
    const device = pick(random, world.devices);
    if (device !== undefined && !state.dark.has(device.name))
      setRelay(device, !(state.relayUp.get(device.name) ?? false), "schedule", ledger, state);
  }

  if (chance(random, plan.reachFlip)) {
    const device = pick(random, world.devices);
    if (device !== undefined && !state.dark.has(device.name)) {
      const others = world.devices.filter((d) => d !== device && d.wiring.ble).map((d) => d.name);
      setReach(
        world,
        device,
        others.filter(() => chance(random, 0.5)),
        "range",
        ledger,
      );
    }
  }

  if (!chance(random, plan.darkFlip)) return;
  const device = pick(random, world.devices);
  // the sleeper's darkness is the schedule's, not the dice's: it wakes at heal and not before
  if (device === undefined || device.name === state.sleeper) return;
  if (state.dark.has(device.name)) {
    state.dark.delete(device.name);
    if (device.wiring.relay) setRelay(device, true, "came back", ledger, state);
    setReach(world, device, undefined, "came back", ledger);
    return;
  }
  goDark(world, device, "went dark", ledger, state);
}

const goDark = (world: World, device: Device, why: string, ledger: Ledger, state: State) => {
  state.dark.add(device.name);
  setRelay(device, false, why, ledger, state);
  setReach(world, device, [], why, ledger);
};

/**
 * One write by the device that owns the row it lands on.
 *
 * A dark device writes exactly as a connected one does — that is the whole point of it being
 * dark, and a harness that paused it while it had no link would be testing nothing.
 */
async function writeOnce(
  world: World,
  tick: number,
  n: number,
  random: () => number,
  ledger: Ledger,
  table: TableName,
  state: State,
): Promise<void> {
  const size = world.devices.length;
  const rowNumber = between(random, 0, size * 2 - 1);
  const device = world.devices[ownerOf(rowNumber, size)];
  if (device === undefined) return;
  const id = rowKey(`n${rowNumber}`);
  const held = state.rows.get(rowNumber);
  const op = held === undefined ? "insert" : chance(random, 0.15) ? "delete" : "update";
  const blob =
    state.switches.blobs && op !== "delete" && chance(random, 0.35)
      ? await attach(device, random, ledger, state.blobs)
      : undefined;
  const title = blob ?? `t${tick}-${n}`;
  const ownerId = `acct_${device.name}`;

  const written = await device.mesh.engine.mutate(
    WRITE,
    (tx) => {
      if (op === "insert") tx.insert(table, id, row({ id, title, ownerId, at: tick }));
      else if (op === "delete") tx.delete(table, id);
      else tx.update(table, id, row({ title }));
    },
    { partition: world.partition },
  );

  if (written.isErr()) {
    ledger.write({
      kind: "rejected",
      device: device.name,
      table,
      key: id,
      reason: written.error.message,
    });
    return;
  }
  if (op === "delete") state.rows.delete(rowNumber);
  else state.rows.set(rowNumber, title);
  ledger.write({
    kind: "authored",
    device: device.name,
    table,
    key: id,
    op,
    values: op === "delete" ? {} : op === "insert" ? { id, title, ownerId } : { title },
    stamp: stampText(eventStamp(written.value)),
    eventId: written.value.id,
    author: written.value.peerId,
    seqNum: written.value.seqNum,
  });
}

/** The state a run starts from, with the sleeper already dark when there is one. */
function prepare(
  world: World,
  plan: Plan,
  random: () => number,
  ledger: Ledger,
  switches: Switches,
) {
  const sleeper = chooseSleeper(world, switches, random, ledger);
  const state: State = {
    rows: new Map(),
    dark: new Set(),
    relayUp: new Map(),
    switches,
    sleeper,
    granted: new Set(),
    blobs: new Map(),
  };
  for (const device of world.devices) state.relayUp.set(device.name, device.wiring.relay);
  world.air.setLoss(plan.loss);
  const sleeping = world.devices.find((device) => device.name === sleeper);
  if (sleeping !== undefined) goDark(world, sleeping, "sleeps past the floor", ledger, state);
  return state;
}

/** Everything back up, and long enough to finish: what is missing after this is missing. */
async function heal(world: World, ledger: Ledger, state: State): Promise<void> {
  ledger.write({ kind: "note", text: "healing" });
  world.air.setLoss(0);
  for (const device of world.devices) {
    state.dark.delete(device.name);
    setRelay(device, true, "heal", ledger, state);
    setReach(world, device, undefined, "heal", ledger);
  }
  for (let round = 0; round < 12; round += 1) {
    if (advertises(state.switches)) world.air.readvertise();
    await settle(world, 250);
  }
}

/**
 * Runs the plan. Everything worth knowing is in the ledger; what comes back is only what a ledger
 * line cannot hold — the bytes of each blob, for the read-back after heal.
 */
export async function runPlan(
  world: World,
  plan: Plan,
  random: () => number,
  ledger: Ledger,
  table: TableName,
  switches: Switches,
): Promise<Outcome> {
  const state = prepare(world, plan, random, ledger, switches);

  for (let tick = 0; tick < plan.ticks; tick += 1) {
    ledger.write({ kind: "note", text: `tick ${tick}` });

    faults(world, plan, random, ledger, state);
    await duringTick(world, { tick, ticks: plan.ticks }, random, ledger, state);

    // a dark device keeps writing: that is the whole point of it being dark
    for (let n = 0; n < plan.writesPerTick; n += 1)
      await writeOnce(world, tick, n, random, ledger, table, state);

    await settle(world, 40);
  }

  if (await beforeHeal(world, ledger, state)) await settle(world, 500);
  await heal(world, ledger, state);
  return { blobs: state.blobs };
}

const settle = async (world: World, ms: number) => {
  await world.air.settle();
  await new Promise((resolve) => setTimeout(resolve, ms));
};
