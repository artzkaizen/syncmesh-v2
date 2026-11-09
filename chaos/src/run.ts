import { readRow } from "@syncmesh/kernel";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import type { Ledger } from "./ledger.js";
import type { Outcome } from "./switches.js";
import type { Switches, Wiring, World } from "./world.js";

import { analyze, render, type Held } from "./analyze.js";
import { key, table } from "./cells.js";
import { checkDigests, checkHeld, renderInvariant, type Holding } from "./invariant.js";
import { createLedger, short } from "./ledger.js";
import { seeded } from "./random.js";
import { reachOver, stateOnlyOver } from "./reach.js";
import { SMALL, runPlan, type Plan } from "./schedule.js";
import { NOTE } from "./schema.js";
import { createWorld } from "./world.js";

/**
 * One run of the mesh under fault, and the file that says what happened.
 *
 * `bun run src/run.ts --seed 7 --devices 6 --ticks 40 [--grants fault] [--blobs] [--retention]`
 *
 * Exits non-zero when a device is missing a write, when the durability invariant finds an
 * acknowledged event a device does not hold, when two devices' digests disagree, or when a blob
 * does not read back — and writes the ledger either way: a run that passes is worth keeping
 * too, because the next one that fails is read against it.
 */

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = Number(process.argv[at + 1]);
  return Number.isNaN(value) ? fallback : value;
};

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const switchesFromArgs = () => {
  const at = process.argv.indexOf("--grants");
  return {
    grants: at !== -1 && process.argv[at + 1] === "fault" ? "fault" : "boot",
    blobs: flag("blobs"),
    retention: flag("retention"),
  } satisfies Switches;
};

/** The switches as the words that turned them on, for the ledger, the report and the run's directory. */
const switchWords = (switches: Switches): readonly string[] => [
  ...(switches.grants === "fault" ? ["grants-fault"] : []),
  ...(switches.blobs ? ["blobs"] : []),
  ...(switches.retention ? ["retention"] : []),
];

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

/** What every device holds, read from its engine: the invariant's evidence. */
async function holdings(world: World): Promise<readonly Holding[]> {
  return Promise.all(
    world.devices.map(async (device) => {
      const { engine } = device.mesh;
      const log = await engine.eventsSince(new Map());
      const cursors = await engine.cursors();
      return {
        device: device.name,
        ids: new Set(log.isOk() ? log.value.map((entry) => entry.event.id) : []),
        cursors: new Map(cursors.isOk() ? [...cursors.value] : []),
        digests: new Map([...engine.digest()].map(([name, digest]) => [name, `${digest}`])),
      };
    }),
  );
}

/**
 * Every referenced blob, read back on every device. A device with no medium that carries bytes
 * answers with a typed refusal, which is recorded rather than counted: it was never able to.
 */
async function readBlobs(world: World, outcome: Outcome, ledger: Ledger): Promise<number> {
  const referenced = new Set(
    ledger
      .entries()
      .flatMap((entry) =>
        entry.kind === "authored" && entry.values.title?.startsWith("b:") === true
          ? [entry.values.title.slice(2)]
          : [],
      ),
  );
  let failures = 0;
  for (const [hex, { hash, bytes }] of outcome.blobs) {
    if (!referenced.has(hex)) continue;
    for (const device of world.devices) {
      const read = await device.mesh.blobs.fetch(hash, { timeoutMs: 2000 });
      const got = read.isOk() ? read.value : undefined;
      const identical =
        got !== undefined &&
        new Bun.CryptoHasher("sha256").update(got).digest("hex") === hex &&
        Buffer.from(got).equals(Buffer.from(bytes));
      const outcomeWord = read.isErr() ? read.error._tag : identical ? "ok" : "mismatch";
      ledger.write({
        kind: "blob",
        device: device.name,
        op: "read",
        hash: hex,
        bytes: got?.byteLength ?? 0,
        outcome: outcomeWord,
      });
      if (outcomeWord === "ok" || outcomeWord === "NoSuchCapability") continue;
      failures += 1;
      ledger.write({
        kind: "violation",
        check: "blob",
        device: device.name,
        detail: `blob ${hex.slice(0, 12)} (${bytes.byteLength} bytes): ${outcomeWord}${read.isErr() ? ` — ${read.error.message}` : ""}`,
      });
    }
  }
  return failures;
}

const main = async () => {
  const seed = arg("seed", 1);
  const devices = arg("devices", 6);
  const switches = switchesFromArgs();
  const words = switchWords(switches);
  const random = seeded(seed);
  const plan: Plan = { ...SMALL, ticks: arg("ticks", SMALL.ticks) };
  const dir = `.chaos/run-${seed}${words.map((word) => `-${word}`).join("")}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const ledger = createLedger();
  ledger.write({
    kind: "note",
    text: `seed ${seed} devices ${devices} ticks ${plan.ticks} switches ${words.join(",") || "none"}`,
  });

  const wirings = wiringFor(devices, random);
  if (!connected(wirings))
    throw new Error("this wiring leaves a device unreachable: the run would report false losses");
  for (const [index, wiring] of wirings.entries())
    ledger.write({
      kind: "note",
      text: `${String.fromCharCode(97 + index)}: relay=${wiring.relay} ble=${wiring.ble}`,
    });

  const world = await createWorld({ devices: wirings, switches, ledger, dir, random });
  const NOTES = table(NOTE);

  try {
    const outcome = await runPlan(world, plan, random, ledger, NOTES, switches);

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
        grants: device.mesh.grants.all().map((grant) => short(grant.device)),
      });
    }

    const blobFailures = switches.blobs ? await readBlobs(world, outcome, ledger) : 0;

    // the durability invariant, from each engine's own log and cursors rather than its rows
    const holding = await holdings(world);
    const told = new Set(
      ledger.entries().flatMap((entry) => (entry.kind === "refused" ? [entry.device] : [])),
    );
    const wirings = new Map(world.devices.map((device) => [device.name, device.wiring]));
    const reaches = reachOver(wirings, told);
    const stateOnly = stateOnlyOver(wirings, told, holding);
    const invariant = checkHeld(ledger.entries(), holding, { reaches, stateOnly });
    const refused = new Set(invariant.refused.map((refusal) => refusal.device));
    const digests = checkDigests(holding, refused);
    for (const violation of [...invariant.violations, ...digests]) ledger.write(violation);

    // a device told by a typed refusal that it would not be served is reported as refused, not
    // as diverged: what the oracle demands of it is that it was told, and the invariant checks that
    // one cut off only from some writes is still held to the rest, by `analyze`'s own reach
    const converging: Held = new Map(
      [...held].filter(([device]) => !(refused.has(device) && told.has(device))),
    );
    const report = analyze(
      ledger.entries(),
      converging,
      (write, device) =>
        reaches(write.device, device) && !stateOnly(device, write.author, write.seqNum),
    );
    const text = [
      render(report, ledger.entries()),
      renderInvariant(invariant, digests),
      ...(switches.blobs
        ? [`blobs: ${outcome.blobs.size} put, ${blobFailures} failed read(s)`]
        : []),
    ].join("\n");
    writeFileSync(`${dir}/ledger.jsonl`, ledger.text());
    writeFileSync(`${dir}/report.txt`, `${text}\n`);
    console.log(text);
    console.log(`\nledger: ${dir}/ledger.jsonl`);
    if (!report.converged) process.exitCode = 1;
    if (invariant.violations.length > 0 || digests.length > 0 || blobFailures > 0)
      process.exitCode = 1;

    // the epilogue's leak check (book ch. 12): the scenario released everything it took, on
    // every device — a held observer here is a leak the run just proved, not a maybe
    for (const device of world.devices) {
      const handles = device.mesh.inspect.handles();
      const leaked = Object.entries(handles).filter(
        ([kind, count]) => kind !== "links" && count > 0,
      );
      if (leaked.length === 0) continue;
      console.log(`${device.name} leaked handles: ${JSON.stringify(Object.fromEntries(leaked))}`);
      process.exitCode = 1;
    }
  } finally {
    await world.stop();
  }
};

await main();
