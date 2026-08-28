import type { Temporal } from "@syncmesh/temporal";

import { durationMs } from "@syncmesh/temporal";

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
   * the life of the host, which is what this table did before the option existed.
   */
  readonly idleAfter?: Temporal.Duration;
  readonly now: () => Temporal.Instant;
}

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
   * the object it replaces, because `entryFor` chains onto this rather than calling `open` at once.
   */
  let closing: Promise<unknown> = Promise.resolve();

  const entryFor = (name: string): Entry => {
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
  const timer = idleMs === undefined ? undefined : setInterval(sweep, every);

  return {
    acquire: async (name) => {
      const entry = entryFor(name);
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
        },
      };
    },
    count: () => entries.size,
    close: async () => {
      if (timer !== undefined) clearInterval(timer);
      for (const [name, entry] of entries) evict(name, entry);
      await closing;
    },
  };
}
