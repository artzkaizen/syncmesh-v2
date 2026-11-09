import type { Wiring } from "./world.js";

/**
 * Whether what one device writes can reach another at all, once the relay serves nobody it
 * refused.
 *
 * The same argument as `connected()` in `run.ts`, one step on. A device the relay refused with
 * `retention` still hands the room what it holds (`refusedBelowFloor` in `@syncmesh/relay`), but
 * the room serves it nothing until it holds the floor — from a peer that folds, and a refused
 * device whose only such peer is behind the relay never does. A Bluetooth-only device whose only
 * way to the relay is that device is then cut off from every relay-side write, and was never able
 * to hold one: an oracle demanding it reports a loss that was never possible (chaos soak,
 * `--retention`, seed 1: the carrier `b` refused, `c`, `d` and `f` behind it).
 *
 * Directed, because the refusal is: the refused device's writes still reach the room.
 */
export function reachOver(
  wirings: ReadonlyMap<string, Wiring>,
  refused: ReadonlySet<string>,
): (from: string, to: string) => boolean {
  const next = linksOver(wirings, refused);
  return (from, to) => search(next, [from], to, () => true);
}

/** Stands for the relay among the device names: a node every relay-wired device links through. */
const RELAY = "\u0000relay";

/** Who each node hands an event to: the air both ways, the relay one way for a refused device. */
const linksOver =
  (wirings: ReadonlyMap<string, Wiring>, refused: ReadonlySet<string>) =>
  (at: string): readonly string[] => {
    if (at === RELAY)
      return [...wirings].flatMap(([name, wiring]) =>
        wiring.relay && !refused.has(name) ? [name] : [],
      );
    const here = wirings.get(at);
    if (here === undefined) return [];
    const air = here.ble
      ? [...wirings].flatMap(([name, wiring]) => (wiring.ble && name !== at ? [name] : []))
      : [];
    return here.relay ? [...air, RELAY] : air;
  };

/** Whether `to` is reached from any of `from`, through nodes `passes` lets an event through. */
const search = (
  next: (at: string) => readonly string[],
  from: readonly string[],
  to: string,
  passes: (at: string) => boolean,
): boolean => {
  if (from.includes(to)) return true;
  const seen = new Set(from);
  const queue = [...from];
  for (let at = queue.shift(); at !== undefined; at = queue.shift())
    for (const there of next(at)) {
      if (there === to) return true;
      if (seen.has(there) || !passes(there)) continue;
      seen.add(there);
      queue.push(there);
    }
  return false;
};

/**
 * Whether what `device` lacks of `author`'s run, from its cursor up to `seq`, can reach it only as
 * state: no device whose log still holds the first event it is missing has a way to it through
 * devices that could take that event into their own logs. A device that compacted past it holds
 * it only as state and drops a copy it is sent (gaps U1), and a relay carries no state (D46: "the
 * way out is state from a peer"); the relay would have paged it to a device it serves had its own
 * log held it. A device with a radio can still take state from a neighbour whose state covers the
 * run, so it is held to it.
 *
 * What makes this reachable at all is `--retention`'s own setting: devices compact with
 * `forgetPeersAfter` 200 ms, so a device away for longer is forgotten and compacted past, by
 * design, and must rejoin from state (RFC-0015 §3). Seeds 1 and 9 at six devices: a relay-only
 * device forgotten by every Bluetooth device that held what it lacked. That it is not *told* is
 * gaps U51.
 */
export function stateOnlyOver(
  wirings: ReadonlyMap<string, Wiring>,
  refused: ReadonlySet<string>,
  holdings: readonly {
    readonly device: string;
    readonly ids: ReadonlySet<string>;
    readonly cursors: ReadonlyMap<string, number>;
  }[],
): (device: string, author: string, seq: number) => boolean {
  const next = linksOver(wirings, refused);
  const cursorOf = (device: string, author: string) =>
    holdings.find((holding) => holding.device === device)?.cursors.get(author) ?? 0;
  return (device, author, seq) => {
    const cursor = cursorOf(device, author);
    if (cursor >= seq) return false;
    // a radio neighbour whose state covers the run is a rejoin from state (D46): held to it
    const ble = wirings.get(device)?.ble === true;
    if (
      ble &&
      holdings.some(
        (holding) =>
          holding.device !== device &&
          wirings.get(holding.device)?.ble === true &&
          cursorOf(holding.device, author) >= seq,
      )
    )
      return false;
    const first = `${author}-${cursor + 1}`;
    const logs = holdings.flatMap((holding) => (holding.ids.has(first) ? [holding.device] : []));
    // an event travels log to log: a device holding the run only as state takes no copy of it
    const passes = (at: string) =>
      at === RELAY || logs.includes(at) || cursorOf(at, author) < cursor + 1;
    return !search(next, logs, device, passes);
  };
}
