import type { PeerId, RowKey, TableName } from "@syncmesh/kernel";
import type { Stamp } from "@syncmesh/kernel";

import { compareStamp, parsePeerId, readRow, stampOf } from "@syncmesh/kernel";

import type { Engine } from "../engine.js";
import type { Link } from "../link.js";

import { createLink } from "../link.js";
import { CREATE, column, row, setup } from "./fixtures.js";

/**
 * A mesh of devices, a topology, and an oracle for what every one of them must end up holding.
 *
 * Two devices is not a mesh. The class of bug this exists for needs a third — a device that is up
 * to date and therefore quiet, so one side runs out of things to say while the other still has
 * some. Every scenario is parameterised over topology for that reason.
 *
 * **The oracle is computed, never written down.** A test asserting a hand-picked winner only
 * proves the author's arithmetic. This records every write as it is made and derives, per cell,
 * which one must survive — so the expectation moves when the merge rules do, and cannot be
 * quietly wrong in the same direction as the code.
 */

export type Topology = "pair" | "line" | "triangle" | "star";

/**
 * One write, carrying **the stamp the engine actually gave it** rather than the millisecond the
 * test asked for. Those are not the same number, and assuming they are is its own bug: an HLC
 * also jumps forward to match any stamp the device has *received*, so two writes scheduled a
 * millisecond apart can end up ordered by their logical counters instead. The oracle compares
 * what the engine stamped, so it measures the engine rather than re-deriving it.
 */
export interface Written {
  readonly by: string;
  readonly stamp: Stamp;
  readonly table: TableName;
  readonly key: RowKey;
  readonly values: Readonly<Record<string, string>>;
  readonly deleted?: boolean;
}

export interface Device {
  readonly name: string;
  readonly peerId: PeerId;
  readonly engine: Engine;
  readonly clock: { readonly set: (ms: number) => void };
}

const peerOf = (index: number): PeerId =>
  parsePeerId(String.fromCharCode(97 + index).repeat(64)).unwrap();

/** Which pairs are linked. A star's hub is the first device — a relay, in everything but name. */
const pairsFor = (topology: Topology, size: number): readonly (readonly [number, number])[] => {
  if (topology === "pair") return [[0, 1]];
  if (topology === "line") return Array.from({ length: size - 1 }, (_, i) => [i, i + 1] as const);
  if (topology === "star") return Array.from({ length: size - 1 }, (_, i) => [0, i + 1] as const);
  return Array.from({ length: size }, (_, i) => [i, (i + 1) % size] as const);
};

export function mesh(topology: Topology, size = topology === "pair" ? 2 : 3) {
  const devices: Device[] = Array.from({ length: size }, (_, i) => {
    const opened = setup(peerOf(i), 100);
    return {
      name: String.fromCharCode(97 + i),
      peerId: peerOf(i),
      engine: opened.engine,
      clock: opened.clock,
    };
  });
  const links: Link[] = pairsFor(topology, size).map(([x, y]) => {
    const from = devices[x];
    const to = devices[y];
    if (from === undefined || to === undefined) throw new Error("topology names a device not here");
    return createLink(from.engine, to.engine);
  });
  const history: Written[] = [];

  const deviceNamed = (name: string): Device => {
    const found = devices.find((d) => d.name === name);
    if (found === undefined) throw new Error(`no device ${name}`);
    return found;
  };

  return {
    devices,
    history,
    apart: () => links.forEach((link) => link.setOnline(false)),
    /**
     * Every link exchanges until nothing moves. Repeated because a line carries a write hop by
     * hop: three devices need two rounds, and asserting after one would pass for the wrong reason.
     */
    heal: async () => {
      links.forEach((link) => link.setOnline(true));
      for (let round = 0; round < size + 2; round += 1)
        for (const link of links) (await link.catchUp()).unwrap();
    },
    write: async (
      name: string,
      at: number,
      table: TableName,
      key: RowKey,
      values: Readonly<Record<string, string>>,
    ) => {
      const device = deviceNamed(name);
      device.clock.set(at);
      const event = (
        await device.engine.mutate(CREATE, (tx) => tx.update(table, key, row(values)))
      ).unwrap();
      history.push({ by: name, stamp: stampOf(event), table, key, values });
    },
    remove: async (name: string, at: number, table: TableName, key: RowKey) => {
      const device = deviceNamed(name);
      device.clock.set(at);
      const event = (await device.engine.mutate(CREATE, (tx) => tx.delete(table, key))).unwrap();
      history.push({ by: name, stamp: stampOf(event), table, key, values: {}, deleted: true });
    },
  };
}

export type Mesh = ReturnType<typeof mesh>;

const cellOn = (device: Device, table: TableName, key: RowKey, name: string) =>
  readRow(device.engine.state(), table, key)?.get(column(name));

/** What every device must hold for one cell, and what it actually holds — as comparable text. */
export interface CellCheck {
  readonly where: string;
  readonly expected: string;
  readonly actual: string;
}

/**
 * What every device must hold, derived from the writes rather than declared.
 *
 * Per cell, the last write to it wins — "last" by the stamp the author used, which is what the
 * engine compares and has nothing to do with who synced first. A row deleted after its last write
 * is gone; one written after the delete is back.
 */
export function noLoss(m: Mesh): readonly CellCheck[] {
  const cells = new Map<string, { stamp: Stamp; value: string }>();
  const deletes = new Map<string, Stamp>();
  const lastWrite = new Map<string, Stamp>();
  const later = (a: Stamp | undefined, b: Stamp): Stamp =>
    a === undefined || compareStamp(b, a) > 0 ? b : a;
  for (const w of m.history) {
    const rowId = `${String(w.table)}\u0000${String(w.key)}`;
    if (w.deleted === true) {
      deletes.set(rowId, later(deletes.get(rowId), w.stamp));
      continue;
    }
    lastWrite.set(rowId, later(lastWrite.get(rowId), w.stamp));
    for (const [name, value] of Object.entries(w.values)) {
      const id = `${rowId}\u0000${name}`;
      const held = cells.get(id);
      if (held === undefined || compareStamp(w.stamp, held.stamp) > 0)
        cells.set(id, { stamp: w.stamp, value });
    }
  }

  const checks: CellCheck[] = [];
  for (const [id, winner] of cells) {
    const [table, key, name] = id.split("\u0000");
    if (table === undefined || key === undefined || name === undefined) continue;
    const rowId = `${table}\u0000${key}`;
    const removed = deletes.get(rowId);
    const written = lastWrite.get(rowId);
    const gone =
      removed !== undefined && (written === undefined || compareStamp(removed, written) > 0);
    for (const device of m.devices) {
      /* oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- the id was built from a TableName and a RowKey three lines above */
      const held = cellOn(device, table as TableName, key as RowKey, name);
      checks.push({
        where: `${device.name}.${table}.${key}.${name}`,
        expected: gone ? "<deleted>" : winner.value,
        actual: held === undefined ? "<deleted>" : String(held),
      });
    }
  }
  return checks;
}

/** Every device's tables, digested. Divergence shows here even where no write was lost. */
export function digests(m: Mesh): readonly string[][] {
  return m.devices.map((device) =>
    [...device.engine.digest()].map(([table, d]) => `${String(table)}=${d}`).sort(),
  );
}
