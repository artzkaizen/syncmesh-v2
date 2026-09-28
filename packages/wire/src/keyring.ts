import type { PartitionKey } from "@syncmesh/kernel";

import type { Grant } from "./grant.js";
import type { Identity } from "./identity.js";
import type { ContentKey, EventCrypto, KeyEpoch } from "./sealing.js";

import { epochOf, openPayload, sealPayload, unwrapKey } from "./sealing.js";

/**
 * The sealed partitions this device can read, and the only place it decides that (book ch. 14).
 *
 * Keys arrive the one way they can: inside a verified grant, wrapped to this device. A key ring
 * with nothing in it is not broken — it is what every carrier has, and what makes a relay a
 * relay. `crypto()` is what an envelope asks, and it answers `undefined` for everything it holds
 * no key for, which is the difference between "carry this" and "read this".
 */
export interface KeyRing {
  /**
   * Takes the keys out of one verified grant. Registering a grant is the only way in: a key
   * that arrived by any other route would be a right nobody signed for.
   */
  readonly learn: (grant: Grant) => void;
  /**
   * The key this device would write under — the newest epoch it holds — or `undefined` when it
   * holds none. Reading uses whichever epoch the payload names, which is not always this one.
   */
  readonly keyFor: (partition: PartitionKey) => ContentKey | undefined;
  /** One particular epoch's key, for reading something written before the last rotation. */
  readonly keyAt: (partition: PartitionKey, epoch: KeyEpoch) => ContentKey | undefined;
  /** The newest epoch held for a partition; `undefined` when none is. */
  readonly epochFor: (partition: PartitionKey) => KeyEpoch | undefined;
  /** The partitions this device can read the content of. `$status` says so; nothing else needs it. */
  readonly sealed: () => readonly PartitionKey[];
  /** Forgets one partition's key — a grant revoked, or a partition detached. */
  readonly forget: (partition: PartitionKey) => void;
  /** What an envelope needs to seal what it sends and open what it can. */
  readonly crypto: () => EventCrypto;
}

export function createKeyRing(identity: Identity): KeyRing {
  /**
   * Every epoch this device holds, per partition.
   *
   * More than one on purpose. A rotated partition is one where the newest key is what to write
   * under and the older ones are what its own history is under — a ring that kept only the
   * current key would make everything this device already carries unreadable the moment the
   * issuer turned it.
   */
  const keys = new Map<PartitionKey, Map<KeyEpoch, ContentKey>>();

  const newest = (partition: PartitionKey): KeyEpoch | undefined => {
    const held = keys.get(partition);
    if (held === undefined || held.size === 0) return undefined;
    return Math.max(...held.keys());
  };
  const at = (partition: PartitionKey, epoch: KeyEpoch): ContentKey | undefined =>
    keys.get(partition)?.get(epoch);

  return {
    learn: (grant) => {
      if (grant.keys === undefined) return;
      // a grant for another device carries keys this one cannot open, and that is not an error:
      // grants are relayed through devices they are not addressed to, all the time
      if (grant.device !== identity.peerId) return;
      for (const { partition, epoch, wrapped } of grant.keys) {
        const key = unwrapKey(identity, wrapped);
        if (key.isErr()) continue;
        const held = keys.get(partition) ?? new Map<KeyEpoch, ContentKey>();
        held.set(epoch, key.value);
        keys.set(partition, held);
      }
    },
    keyFor: (partition) => {
      const epoch = newest(partition);
      return epoch === undefined ? undefined : at(partition, epoch);
    },
    keyAt: at,
    epochFor: newest,
    sealed: () => [...keys.keys()],
    forget: (partition) => void keys.delete(partition),
    crypto: () => ({
      seal: (partition, plain, aad) => {
        // always the newest: a device still holding an old epoch must not write under it, or a
        // revoked peer would go on reading writes made after it was cut out
        const epoch = newest(partition);
        const key = epoch === undefined ? undefined : at(partition, epoch);
        return key === undefined || epoch === undefined
          ? undefined
          : sealPayload(key, plain, aad, epoch);
      },
      open: (partition, sealed, aad) => {
        const epoch = epochOf(sealed);
        const key = epoch === undefined ? undefined : at(partition, epoch);
        // no key for that epoch: written before this device was admitted, or after it was cut
        // out. Either way it is still carried — the signature over it is the author's
        if (key === undefined) return undefined;
        const opened = openPayload(key, sealed, aad);
        return opened.isOk() ? opened.value : undefined;
      },
    }),
  };
}
