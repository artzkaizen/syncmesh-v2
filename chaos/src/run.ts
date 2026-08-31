import { readRow } from "@syncmesh/kernel";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import type { Wiring } from "./world.js";

import { analyze, render, type Held } from "./analyze.js";
import { key, table } from "./cells.js";
import { createLedger } from "./ledger.js";
import { seeded } from "./random.js";
import { SMALL, runPlan, type Plan } from "./schedule.js";
import { NOTE } from "./schema.js";
import { createWorld } from "./world.js";

/**
 * One run of the mesh under fault, and the file that says what happened.
 *
 * `bun run src/run.ts --seed 7 --devices 6 --ticks 40`
 *
 * Exits non-zero when a device is missing a write, and writes the ledger either way — a run that
 * passes is worth keeping too, because the next one that fails is read against it.
 */

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = Number(process.argv[at + 1]);
  return Number.isNaN(value) ? fallback : value;
};

/**
 * Who has which radio, and always a path between them.
 *
 * Not uniform on purpose: the mesh in the field is a few devices on the relay, a few on Bluetooth
 * with no network at all, and one carrying events between them. That carrier is the point — with
 * only relay-only and Bluetooth-only devices there is no path at all, and every "lost" event is
 * the harness asking for something the wiring never allowed. `connected` below keeps that an
 * assertion rather than a thing to remember.
 */
const wiringFor = (count: number, random: () => number): readonly Wiring[] =>
  Array.from({ length: count }, (_, index) => {
    if (index === 0) return { relay: true, ble: false };
    // the carrier: on both, so the relay side and the nearby side are one mesh
    if (index === 1) return { relay: true, ble: true };
    if (index === 2) return { relay: false, ble: true };
    const wiring = { relay: random() < 0.6, ble: random() < 0.8 };
    return wiring.relay || wiring.ble ? wiring : { relay: true, ble: true };
  });

/**
 * Whether every device can reach every other once the faults are lifted.
 *
 * Two devices are adjacent if they share a link: the relay joins everyone on it, the air joins
 * everyone with a radio. An oracle demanding convergence across a mesh with no path through it
 * reports losses that were never possible, which is worse than reporting nothing.
 */
const connected = (wirings: readonly Wiring[]): boolean => {
  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const at = queue.shift();
    if (at === undefined) continue;
    const here = wirings[at];
    if (here === undefined) continue;
    for (const [index, there] of wirings.entries()) {
      if (seen.has(index)) continue;
      if ((here.relay && there.relay) || (here.ble && there.ble)) {
        seen.add(index);
        queue.push(index);
      }
    }
  }
  return seen.size === wirings.length;
};

const main = async () => {
  const seed = arg("seed", 1);
  const devices = arg("devices", 6);
  const random = seeded(seed);
  const plan: Plan = { ...SMALL, ticks: arg("ticks", SMALL.ticks) };
  const dir = `.chaos/run-${seed}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const ledger = createLedger();
  ledger.write({
    kind: "note",
    text: `seed ${seed} devices ${devices} ticks ${plan.ticks}`,
  });

  const wirings = wiringFor(devices, random);
  if (!connected(wirings))
    throw new Error("this wiring leaves a device unreachable: the run would report false losses");
  for (const [index, wiring] of wirings.entries())
    ledger.write({
      kind: "note",
      text: `${String.fromCharCode(97 + index)}: relay=${wiring.relay} ble=${wiring.ble}`,
    });

  const world = await createWorld({ devices: wirings, ledger, dir, random });
  const NOTES = table(NOTE);

  try {
    await runPlan(world, plan, random, ledger, NOTES);

    // what every device holds at the end, read from its own state rather than from the log
    const held: Held = new Map(
      world.devices.map((device) => {
        const rows = new Map<string, Record<string, string>>();
        for (let n = 0; n < devices * 2; n += 1) {
          const id = `n${n}`;
          const row = readRow(device.mesh.engine.state(), NOTES, key(id));
          if (row === undefined) continue;
          rows.set(id, Object.fromEntries([...row].map(([name, value]) => [name, `${value}`])));
        }
        return [device.name, rows];
      }),
    );

    for (const device of world.devices) {
      const cursors = await device.mesh.engine.cursors();
      ledger.write({
        kind: "snapshot",
        device: device.name,
        cursors: cursors.isOk()
          ? Object.fromEntries([...cursors.value].map(([peer, seq]) => [peer.slice(0, 8), seq]))
          : {},
        digests: Object.fromEntries(
          [...device.mesh.engine.digest()].map(([name, digest]) => [name, `${digest}`]),
        ),
        quarantined: device.mesh.engine.quarantine().length,
      });
    }

    const report = analyze(ledger.entries(), held);
    const text = render(report, ledger.entries());
    writeFileSync(`${dir}/ledger.jsonl`, ledger.text());
    writeFileSync(`${dir}/report.txt`, `${text}\n`);
    console.log(text);
    console.log(`\nledger: ${dir}/ledger.jsonl`);
    if (!report.converged) process.exitCode = 1;
  } finally {
    await world.stop();
  }
};

await main();
