import type { PartitionKey, PeerId } from "@syncmesh/kernel";

import type { WrappedKey } from "./grant.js";
import type { ContentKey, KeyEpoch } from "./sealing.js";

import { FIRST_EPOCH, newContentKey, wrapKey } from "./sealing.js";

/** One content key the issuer holds: a partition, an epoch, and the key itself. */
export interface HeldKey {
  readonly partition: PartitionKey;
  readonly epoch: KeyEpoch;
  readonly key: ContentKey;
}

/**
 * The issuer's half of sealing (book ch. 14, D40): the content key of every sealed partition, at
 * every epoch, and the one way a device gets its copies — wrapped into the grant that admits it.
 *
 * A device's {@link KeyRing} is the reading half; this is where keys come from. It mints a
 * partition's first key the first time a grant over it is wrapped, and a new epoch when a member
 * is removed: the removed device keeps the epochs it already held, which is everything it already
 * read, and gets none written after. No scheme takes back a read.
 *
 * **Persist {@link held}.** These keys are the only copy the issuer has; lose them and every
 * sealed partition's history is ciphertext nobody can open, including the issuer.
 *
 * @example
 * ```ts
 * const keys = createPartitionKeys({ sealed: (p) => kindOf(p) === "hr", held: await load() });
 * issueGrant(issuer, { ...request, keys: keys.wrap(device, request.partitions) });
 * keys.rotate(hr); // a member left: grants re-issued from here carry epoch 2
 * ```
 */
export interface PartitionKeys {
  /**
   * Every epoch's key for each sealed partition among `partitions`, wrapped to `device`: what a
   * grant for it carries. Every epoch rather than the newest, so the device can read the history
   * it is admitted to and not only what is written from now on.
   */
  readonly wrap: (device: PeerId, partitions: readonly PartitionKey[]) => readonly WrappedKey[];
  /** Starts the next epoch for one sealed partition and returns it; the first when there is none. */
  readonly rotate: (partition: PartitionKey) => KeyEpoch;
  /** The newest epoch held for a partition; `undefined` before its first key. */
  readonly epoch: (partition: PartitionKey) => KeyEpoch | undefined;
  /** Every key held, oldest epoch first — what an issuer persists. */
  readonly held: () => readonly HeldKey[];
}

export interface PartitionKeysOptions {
  /** Whether a partition's content is sealed; only those have keys. */
  readonly sealed: (partition: PartitionKey) => boolean;
  /** The keys a previous run persisted from {@link PartitionKeys.held}. */
  readonly held?: readonly HeldKey[];
}

export function createPartitionKeys(options: PartitionKeysOptions): PartitionKeys {
  const keys = new Map<PartitionKey, Map<KeyEpoch, ContentKey>>();
  for (const { partition, epoch, key } of options.held ?? [])
    keys.set(partition, (keys.get(partition) ?? new Map()).set(epoch, key));

  const newest = (partition: PartitionKey): KeyEpoch | undefined => {
    const held = keys.get(partition);
    return held === undefined || held.size === 0 ? undefined : Math.max(...held.keys());
  };
  const rotate = (partition: PartitionKey): KeyEpoch => {
    const next = (newest(partition) ?? FIRST_EPOCH - 1) + 1;
    keys.set(partition, (keys.get(partition) ?? new Map()).set(next, newContentKey()));
    return next;
  };

  return {
    wrap: (device, partitions) =>
      partitions.filter(options.sealed).flatMap((partition) => {
        if (newest(partition) === undefined) rotate(partition);
        const held = [...(keys.get(partition) ?? new Map<KeyEpoch, ContentKey>())];
        return held
          .sort(([a], [b]) => a - b)
          .map(([epoch, key]) => ({ partition, epoch, wrapped: wrapKey(device, key) }));
      }),
    rotate,
    epoch: newest,
    held: () =>
      [...keys].flatMap(([partition, epochs]) =>
        [...epochs].sort(([a], [b]) => a - b).map(([epoch, key]) => ({ partition, epoch, key })),
      ),
  };
}
