import { Temporal, durationMs } from "@syncmesh/temporal";

import type { GrantCache } from "./grant-cache.js";
import type { RelayRoom } from "./room.js";

import { createGrantCache } from "./grant-cache.js";
import { DEFAULT_SWEEP } from "./retention.js";

/**
 * A host's open rooms, and the one question an idle-room cap has to answer: what an eviction
 * takes away, and what a re-join puts back.
 *
 * Gone with the object, rebuilt on the next join: the client table (empty by definition — a room
 * with a socket on it is never evicted), the presence tier (last-value-per-peer, and every peer
 * whose value it held has left), and the room's cursors, which the re-open recomputes from the
 * log and the compaction floor. Kept on disk and untouched: the log and the blobs — and the epoch
 * with them, so long as the host reads it from the log rather than minting one per `open` (the
 * default host persists it in `_relay_meta`, and a caller-supplied store gets one per process).
 *
 * The grant cache is neither. A device sends its grants once, immediately after joining, and
 * never again — so a room re-opened with an empty one holds the grants of exactly the devices
 * connected at that moment, and the next joiner is paged a catch-up whose events it can validate
 * none of. That is the bug the Durable Object host already shipped and its resume script now
 * carries around; a host that evicts rooms in its own memory can simply keep the cache, which is
 * one wire per device and not what an eviction is trying to reclaim.
 */
export interface OpenedRoom {
  readonly room: RelayRoom;
  /** What the room borrowed from the host — its log file handle — given back when it is evicted. */
  readonly release: () => Promise<void> | void;
}

export interface RoomTableOptions {
  /** Opens one room, with the grant cache the table is keeping for that name across evictions. */
  readonly open: (name: string, grants: GrantCache) => Promise<OpenedRoom>;
  /**
   * How long a room with no socket on it is kept open. Absent, a room opened once is held for
   * the life of the host, which is what this table did before the option existed. Zero closes a
   * room on its last release, with no sweep timer: what a host that must go quiet to hibernate
   * (a Durable Object) needs, since a timer left running keeps it awake.
   */
  readonly idleAfter?: Temporal.Duration;
  readonly now: () => Temporal.Instant;
}

/**
 * How long a durable host keeps a room nobody is on, when its caller did not say: `startRelay`
 * on Bun and Node both default to it over their own `dataDir`. A caller-supplied store keeps
 * the old default of never — its room borrows no handle, so an eviction would reclaim nothing
 * and re-read the whole log on the next join.
 */
export const DEFAULT_IDLE_AFTER = Temporal.Duration.from({ minutes: 15 });

/** One room, held open for as long as the socket that asked for it is on it. */
export interface HeldRoom {
  readonly room: RelayRoom;
  /** Called exactly once per `acquire`, whatever happens to the socket; extra calls do nothing. */
  readonly release: () => void;
}

export interface RoomTable {
  /**
   * The room for that name, opening it if this is the first socket. Counted from **before** the
   * open is awaited, so a room can never be evicted out from under a socket that is still being
   * accepted: `clients()` is zero until a `join` frame lands, and the window between the two is
   * exactly where a table that counted joined clients would drop the room.
   */
  readonly acquire: (name: string) => Promise<HeldRoom>;
  readonly count: () => number;
  /** Rooms with at least one socket on them: the ones {@link evictIdlest} cannot close. */
  readonly occupied: () => number;
  /**
   * Closes the room that has gone longest with no socket on it, so a cap on open rooms counts the
   * rooms people are on rather than every name ever opened. `false` when every room has a socket.
   */
  readonly evictIdlest: () => boolean;
  /**
   * Sockets holding that room, counted the way {@link acquire} counts them — from before the
   * open — or `undefined` when the table does not hold it open at all.
   */
  readonly sockets: (name: string) => number | undefined;
  readonly close: () => Promise<void>;
}

interface Entry {
  readonly opened: Promise<OpenedRoom>;
  sockets: number;
  /** When this room last had its socket count reach zero; `undefined` while one is on it. */
  idleSince: Temporal.Instant | undefined;
}

export function createRoomTable(options: RoomTableOptions): RoomTable {
  const entries = new Map<string, Entry>();
  /** Outlives the rooms themselves, which is the whole point; one grant wire per device. */
  const grants = new Map<string, GrantCache>();
  /**
   * Evictions in order, and every open behind them: a re-open of a name cannot race the close of
   * the object it replaces, because `ensureEntry` chains onto this rather than calling `open` at once.
   */
  let closing: Promise<unknown> = Promise.resolve();

  const ensureEntry = (name: string): Entry => {
    const held = entries.get(name);
    if (held !== undefined) return held;
    const cache = grants.get(name) ?? createGrantCache();
    grants.set(name, cache);
    // behind the evictions already queued, and that is the whole point: on the default host a
    // room's handle is a SQLite file named after it, so opening the new object before the old
    // one has given its handle back is two writers on one file
    const fresh: Entry = {
      opened: closing.then(() => options.open(name, cache)),
      sockets: 0,
      idleSince: undefined,
    };
    entries.set(name, fresh);
    return fresh;
  };

  const evict = (name: string, entry: Entry): void => {
    entries.delete(name);
    closing = closing
      .then(async () => {
        const opened = await entry.opened;
        opened.room.close();
        await opened.release();
      })
      .catch(() => undefined); // a log that fails to close is not a reason to stop evicting
  };

  const idleMs = options.idleAfter === undefined ? undefined : durationMs(options.idleAfter);
  const sweep = (): void => {
    const at = options.now();
    for (const [name, entry] of entries) {
      if (entry.sockets > 0) {
        entry.idleSince = undefined;
        continue;
      }
      entry.idleSince ??= at;
      if (
        idleMs !== undefined &&
        entry.idleSince.until(at).total({ unit: "milliseconds" }) >= idleMs
      )
        evict(name, entry);
    }
  };

  // checked no less often than the deadline itself, or a short `idleAfter` would be rounded up to
  // the sweep it happens to land in rather than being the bound it says it is
  const every = Math.min(durationMs(DEFAULT_SWEEP), idleMs ?? Infinity);
  const timer = idleMs === undefined || idleMs === 0 ? undefined : setInterval(sweep, every);

  return {
    acquire: async (name) => {
      const entry = ensureEntry(name);
      entry.sockets += 1;
      entry.idleSince = undefined;
      const { room } = await entry.opened;
      let done = false;
      return {
        room,
        release: () => {
          if (done) return;
          done = true;
          entry.sockets -= 1;
          if (entry.sockets > 0) return;
          entry.idleSince = options.now();
          // a zero window closes the room now: no sweep runs to close it later
          if (idleMs === 0 && entries.get(name) === entry) evict(name, entry);
        },
      };
    },
    count: () => entries.size,
    occupied: () => [...entries.values()].filter((entry) => entry.sockets > 0).length,
    evictIdlest: () => {
      let idlest: [string, Entry, Temporal.Instant] | undefined;
      for (const [name, entry] of entries) {
        if (entry.sockets > 0 || entry.idleSince === undefined) continue;
        if (idlest === undefined || Temporal.Instant.compare(entry.idleSince, idlest[2]) < 0)
          idlest = [name, entry, entry.idleSince];
      }
      if (idlest === undefined) return false;
      evict(idlest[0], idlest[1]);
      return true;
    },
    sockets: (name) => entries.get(name)?.sockets,
    close: async () => {
      if (timer !== undefined) clearInterval(timer);
      for (const [name, entry] of entries) evict(name, entry);
      await closing;
    },
  };
}
