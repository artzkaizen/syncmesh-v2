import type { CellValue, ColumnName, PartitionKey, PeerId, Row } from "@syncmesh/kernel";
import type { Columns, PresenceMap, PresenceTopic, Value } from "@syncmesh/schema";
import type { Temporal } from "@syncmesh/temporal";
import type { PresenceEntry, PresenceStore } from "@syncmesh/transport";
import type { Identity, Presence } from "@syncmesh/wire";

import { panic } from "@syncmesh/result";
import { checkValue } from "@syncmesh/schema";
import { createPresenceStore } from "@syncmesh/transport";
import { decodeAndVerifyPresence, signPresence } from "@syncmesh/wire";

/** A topic's value as its columns declare it — the same mapping a row gets. */
export type ValueOf<C extends Columns> = { readonly [K in keyof C]: Value<C[K]> };

/** The topics of one instance, each typed by what its manifest entry declared. */
export type Topics<PC extends PresenceMap> = { readonly [K in keyof PC]: Topic<ValueOf<PC[K]>> };

/** A person at a topic right now: which device, whose account, what value, since when. */
export interface Peer<V> {
  readonly peerId: PeerId;
  /** The account the device's grant names; two tabs of one person share it. `undefined` when ungranted. */
  readonly account: string | undefined;
  readonly value: V;
  readonly at: Temporal.Instant;
}

/**
 * One topic, pinned to one instance. `set` is a `void` call on purpose (D16): it sits in a
 * pointer handler at 60 Hz, and a `Result` nobody unwraps trains people to ignore return values.
 * A value that fails its shape is a definition mistake and panics; a value that cannot leave a
 * full radio is dropped, because the next one replaces it anyway.
 */
export interface Topic<V> {
  /** Publishes this device's current value; conflated at every hop, never queued. */
  readonly set: (value: V) => void;
  /** Explicit departure — a closing tab vanishes now rather than at TTL. */
  readonly clear: () => void;
  /** Everyone currently here, this device included once it has set a value. */
  readonly peers: () => readonly Peer<V>[];
  /** Fires when anyone's value here changes, including expiry. */
  readonly subscribe: (listener: () => void) => () => void;
}

export interface PresenceDeps {
  readonly identity: Identity;
  readonly topics: readonly PresenceTopic[];
  readonly store: PresenceStore;
  /** Sends one signed value to every open session; absent, presence stays on this device. */
  readonly send: (wire: Uint8Array) => void;
  readonly now: () => Temporal.Instant;
}

/** A value as its topic declares it, checked column by column — the same check a row gets. */
function checkedRow(topic: PresenceTopic, value: Readonly<Record<string, CellValue>>): Row {
  const row = new Map<ColumnName, CellValue>();
  for (const [key, column] of Object.entries(topic.columns)) {
    const cell = value[key] ?? null;
    const checked = checkValue(column, cell);
    if (checked.isErr()) panic(`presence ${topic.name}.${key}: ${checked.error.message}`);
    // SAFETY: the topic's keys passed parseColumnName when the manifest was defined
    row.set(key as ColumnName, cell);
  }
  for (const key of Object.keys(value))
    if (!(key in topic.columns)) panic(`presence ${topic.name}: no column "${key}"`);
  return row;
}

const plain = <V>(row: Row): V =>
  // SAFETY: the row's cells passed the topic's own column checks, which is what V describes
  Object.fromEntries([...row].map(([column, cell]) => [String(column), cell])) as V;

/**
 * One `Peer` per store entry, remembered. The store replaces an entry only when its value
 * changed, so a reader comparing by identity — `useSyncExternalStore` does — sees no change
 * until there is one, and a 60 Hz topic nobody moved on costs no renders.
 */
const mapped = new WeakMap<PresenceEntry, Peer<never>>();
const peerOf = <V>(entry: PresenceEntry): Peer<V> => {
  const held = mapped.get(entry);
  if (held !== undefined) {
    // SAFETY: an entry is cached by the one topic that reads it, whose shape V names
    return held as Peer<V>;
  }
  const peer: Peer<V> = {
    peerId: entry.peerId,
    account: entry.account,
    value: plain<V>(entry.value),
    at: entry.at,
  };
  // SAFETY: as above — the cache is keyed by the entry, so V is fixed per key
  mapped.set(entry, peer as Peer<never>);
  return peer;
};

/**
 * The ephemeral tier at the app's door (D16). Values are signed like events and resemble them in
 * nothing else: never appended, never folded, never in catch-up. Each topic keeps this device's
 * last value alive with a heartbeat at a third of its TTL, so a peer that stops moving stays
 * present and a peer that stops existing disappears on its own.
 */
export function createPresence(deps: PresenceDeps) {
  const { identity, store, send, now } = deps;
  const byName = new Map(deps.topics.map((topic) => [topic.name, topic]));
  const session = crypto.randomUUID();
  let count = 0;
  /** This device's live values, so a heartbeat can re-send them and `stop` can clear them. */
  const mine = new Map<string, { readonly topic: PresenceTopic; readonly value: Row | null }>();
  const beats = new Map<string, ReturnType<typeof setInterval>>();

  const publish = (topic: PresenceTopic, partition: PartitionKey, value: Row | null): void => {
    count += 1;
    const presence: Presence = {
      v: 1,
      peerId: identity.peerId,
      topic: topic.name,
      partition,
      session,
      count,
      value,
      expires: now().epochMilliseconds + topic.ttlMs,
    };
    const signed = signPresence(presence, identity);
    store.admit(signed);
    send(signed.wire);
  };

  const key = (topic: string, partition: PartitionKey) => `${topic} ${String(partition)}`;

  const topicFor = <V>(name: string, partition: PartitionKey): Topic<V> => {
    const topic = byName.get(name) ?? panic(`presence: no topic "${name}"`);
    const slot = key(name, partition);
    return {
      set: (value) => {
        // SAFETY: V is the topic's declared shape; the check below is what proves each cell
        const row = checkedRow(topic, value as Readonly<Record<string, CellValue>>);
        mine.set(slot, { topic, value: row });
        publish(topic, partition, row);
        if (!beats.has(slot)) {
          // a third of the TTL: two heartbeats may be lost before a live peer looks gone
          const beat = setInterval(
            () => {
              const held = mine.get(slot);
              if (held?.value != null) publish(topic, partition, held.value);
            },
            Math.max(1, Math.floor(topic.ttlMs / 3)),
          );
          beat.unref?.();
          beats.set(slot, beat);
        }
      },
      clear: () => {
        mine.delete(slot);
        const beat = beats.get(slot);
        if (beat !== undefined) {
          clearInterval(beat);
          beats.delete(slot);
        }
        publish(topic, partition, null);
      },
      peers: () => store.peers(name, partition).map((entry) => peerOf<V>(entry)),
      subscribe: (listener) =>
        store.subscribe((touched) => {
          if (touched.topic === name && String(touched.partition) === String(partition)) listener();
        }),
    };
  };

  return {
    /** The topics of an instance: `mesh.presence("board:b1").cursor.set({ x, y })`. */
    at: <PC extends PresenceMap>(partition: PartitionKey): Topics<PC> =>
      // SAFETY: one entry per declared topic, each typed by the shape the manifest gave it
      Object.fromEntries(
        [...byName.keys()].map((name) => [name, topicFor(name, partition)]),
      ) as Topics<PC>,
    /** A frame arrived: admit it if it is news, and say so, so a gossiping hop knows to forward. */
    receive: (wire: Uint8Array): boolean => {
      const verified = decodeAndVerifyPresence(wire);
      return verified.isOk() && store.admit(verified.value);
    },
    /** Clears every value this device published, then stops the heartbeats. */
    stop: () => {
      for (const [slot, held] of mine) {
        const partition = slot.slice(slot.indexOf(" ") + 1);
        // SAFETY: the instance this value was published under, as it was parsed then
        publish(held.topic, partition as PartitionKey, null);
      }
      mine.clear();
      for (const beat of beats.values()) clearInterval(beat);
      beats.clear();
    },
  };
}

/**
 * The ephemeral tier, wired (D16): this device's identity, the manifest's topics, and the one
 * place a value may leave from.
 *
 * `send` goes to every open session and nowhere else, because a presence value that cannot leave
 * is dropped rather than queued — assembled here so that rule sits beside the code that keeps it.
 */
export const openPresence = (
  identity: PresenceDeps["identity"],
  topics: PresenceDeps["topics"],
  store: {
    readonly now: PresenceDeps["now"];
    readonly accountOf: (peer: PeerId) => string | undefined;
  },
  send: PresenceDeps["send"],
) =>
  createPresence({
    identity,
    topics,
    store: createPresenceStore({ now: store.now, accountOf: store.accountOf }),
    send,
    now: store.now,
  });
