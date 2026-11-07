import { Temporal } from "@syncmesh/temporal";

import type { Ledger } from "./ledger.js";
import type { Device, Switches, World } from "./world.js";

import { between, chance, pick } from "./random.js";

/**
 * What each schedule switch adds to a tick, kept apart from the original schedule so that with
 * every switch off `schedule.ts` runs exactly as it did — the same calls, the same dice.
 *
 * Every random draw here happens only when its switch is on, which is what keeps a seed's
 * original run reproducible after a switch is added.
 */

/** The hash a blob is put and fetched under, as the mesh's own surface names it. */
export type BlobHash = Parameters<Device["mesh"]["blobs"]["fetch"]>[0];

/** A blob put during the run: the mesh's hash for it, and the bytes, for the read-back. */
export interface HeldBlob {
  readonly hash: BlobHash;
  readonly bytes: Uint8Array;
}

/** What a run leaves behind that the ledger cannot carry: the bytes behind every blob put. */
export interface Outcome {
  /** By lowercase hex sha-256, computed here rather than by the library under test. */
  readonly blobs: ReadonlyMap<string, HeldBlob>;
}

/** The part of the schedule's state the switches read and write. */
export interface SwitchState {
  readonly switches: Switches;
  /** Devices currently dark on every link. */
  readonly dark: ReadonlySet<string>;
  /** Under `retention`, the device that goes dark at the start and stays dark until heal. */
  readonly sleeper: string | undefined;
  /** Late devices already granted, under `grants: "fault"`. */
  readonly granted: Set<string>;
  readonly blobs: Map<string, HeldBlob>;
}

/** A peer silent this long stops pinning a compaction floor, so a sleeper falls below it. */
const FORGET_PEERS_AFTER = Temporal.Duration.from({ milliseconds: 200 });

/**
 * Whether every radio re-advertises once a tick, as a real one does continuously.
 *
 * The virtual air announces only when asked, and a link a door refused — or one that failed — is
 * only ever rebuilt by a later advertisement. The original run never refuses at the door and
 * keeps its one announcement, so its dice fall exactly as they did.
 */
export const advertises = (switches: Switches): boolean =>
  switches.grants === "fault" || switches.blobs || switches.retention;

/** Under `retention`, the device that sleeps past the floor; says so, and who is granted late. */
export function chooseSleeper(
  world: World,
  switches: Switches,
  random: () => number,
  ledger: Ledger,
): string | undefined {
  if (world.late.length > 0)
    ledger.write({
      kind: "note",
      text: `granted mid-run: ${world.late.map((device) => device.name).join(",")}`,
    });
  if (!switches.retention) return undefined;
  const sleeper = pick(random, world.devices.slice(1))?.name;
  if (sleeper !== undefined) ledger.write({ kind: "note", text: `sleeper: ${sleeper}` });
  return sleeper;
}

/** Under `grants: "fault"`, the issuer grants a waiting device — always by half-time, so under fault. */
function grants(
  world: World,
  at: { readonly tick: number; readonly ticks: number },
  random: () => number,
  ledger: Ledger,
  state: SwitchState,
): void {
  const waiting = world.late.filter((device) => !state.granted.has(device.name));
  const due = at.tick >= Math.floor(at.ticks / 2) ? waiting : [];
  const chosen = chance(random, 0.35) ? pick(random, waiting) : undefined;
  for (const device of chosen === undefined ? due : [chosen, ...due]) {
    if (state.granted.has(device.name)) continue;
    state.granted.add(device.name);
    const granted = world.grant(device);
    if (granted.isOk()) ledger.write({ kind: "granted", device: device.name });
    else
      ledger.write({
        kind: "note",
        text: `grant for ${device.name} failed: ${granted.error._tag}: ${granted.error.message}`,
      });
  }
}

/** One device compacts its log against what its peers have acknowledged, forgetting the silent. */
async function compact(device: Device, ledger: Ledger): Promise<void> {
  const compacted = await device.mesh.engine.compact({
    now: Temporal.Now.instant(),
    forgetPeersAfter: FORGET_PEERS_AFTER,
  });
  ledger.write(
    compacted.isOk()
      ? {
          kind: "compacted",
          device: device.name,
          removed: compacted.value.removed,
          floor: Object.fromEntries(compacted.value.floor.synced),
        }
      : {
          kind: "compacted",
          device: device.name,
          removed: 0,
          floor: {},
          error: `${compacted.error._tag}: ${compacted.error.message}`,
        },
  );
}

/** The devices neither asleep nor dark: the ones a compaction can run on. */
const awake = (world: World, state: SwitchState) =>
  world.devices.filter((device) => device.name !== state.sleeper && !state.dark.has(device.name));

/** One tick's worth of every switch that is on: advertisements, grants, compaction. */
export async function duringTick(
  world: World,
  at: { readonly tick: number; readonly ticks: number },
  random: () => number,
  ledger: Ledger,
  state: SwitchState,
): Promise<void> {
  const { switches } = state;
  if (advertises(switches)) world.air.readvertise();
  if (switches.grants === "fault") grants(world, at, random, ledger, state);
  if (!switches.retention || !chance(random, 0.3)) return;
  // some awake device compacts at random, so the floor rises mid-fault
  const device = pick(random, awake(world, state));
  if (device !== undefined) await compact(device, ledger);
}

/**
 * Under `retention`, the floor at its highest before the sleeper wakes: every awake device
 * compacts once more. Answers whether it did, so the caller can let the relay's sweep run too.
 */
export async function beforeHeal(
  world: World,
  ledger: Ledger,
  state: SwitchState,
): Promise<boolean> {
  if (!state.switches.retention) return false;
  for (const device of awake(world, state)) await compact(device, ledger);
  return true;
}

/** Bytes drawn from the seed, so a blob that fails to arrive is the same blob on replay. */
const blobBytes = (random: () => number): Uint8Array =>
  Uint8Array.from({ length: between(random, 16, 1024) }, () => Math.floor(random() * 256));

/**
 * Puts a blob on `device` and answers the title that references it, or `undefined` when the put
 * was refused — recorded either way. Put first, write the row second, as the blob API says.
 */
export async function attach(
  device: Device,
  random: () => number,
  ledger: Ledger,
  blobs: Map<string, HeldBlob>,
): Promise<string | undefined> {
  const bytes = blobBytes(random);
  const put = await device.mesh.blobs.put(bytes);
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  ledger.write({
    kind: "blob",
    device: device.name,
    op: "put",
    hash,
    bytes: bytes.byteLength,
    outcome: put.isOk() ? "ok" : put.error._tag,
  });
  if (put.isErr()) return undefined;
  blobs.set(hash, { hash: put.value, bytes });
  return `b:${hash}`;
}
