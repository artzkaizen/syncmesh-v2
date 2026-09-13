import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";

import { TaggedError } from "@syncmesh/result";
import { isRelayable } from "@syncmesh/wire";

import type { EventStore, StoreFailure, StoredEvent } from "./store.js";

/**
 * **This device holds events it can never deliver, and nothing else in the system will say so.**
 *
 * The log keeps another peer's event under the signature it arrived with, and keeps this
 * device's own under none — nothing had signed them when they were written, and the bridge
 * re-signs them on the way out. Those two rules meet at exactly one place: an entry with no
 * signature whose author is *not* this device. No key here can sign it, so `relayEnvelope`
 * refuses it forever; it is below this device's own cursor, so no peer will ever offer it back;
 * and it folded on arrival, so the state it produced is real and local and nowhere else.
 *
 * The way in is a key rotation over a log that was kept. The device authored under one identity,
 * took a new one, and the writes it had not yet handed to anybody became writes it is no longer
 * the author of. Nothing about that is visible at the time, and almost nothing about it is
 * visible afterwards: every last-writer-wins column reads the same on a device that is missing a
 * whole author, because the surviving writes carry the same values. It took a PN-counter — 105
 * on one device and 76 on the other, the difference being exactly one retired identity's cells —
 * to make it observable at all.
 *
 * One report per stranded author rather than per event, because the author is the unit of the
 * problem: a rotation strands a *run*, and a person is being told which identity went quiet and
 * how much went with it, not asked to read 86 lines.
 *
 * **What this is not.** It is not a quarantine: a quarantined event is one this build refused to
 * fold, and these were folded, are part of this device's state, and must stay that way. It is
 * not repairable here either — see {@link strandedWrites} for why re-signing is the wrong answer
 * and not merely a hard one. What it is, is the end of the silence.
 */
export class StrandedWrites extends TaggedError("StrandedWrites")<{
  /** The retired identity: the author no key on this device can sign for any more. */
  author: PeerId;
  count: number;
  /** The run's ends, so "86 events" can be read against what the log otherwise shows. */
  from: SeqNum;
  to: SeqNum;
  message: string;
}> {}

/**
 * Whether this entry is one no key on this device can ever send.
 *
 * A local-only write is excluded rather than overlooked: it was never going anywhere, so it is
 * not stuck. Everything else with no signature and somebody else's name on it is.
 */
export const isStranded = (entry: StoredEvent, mine: PeerId): boolean =>
  !isRelayable(entry) && entry.event.peerId !== mine && entry.event.local !== true;

/**
 * Every author this device holds unsendable writes for, as one report each. Empty is the healthy
 * answer and the overwhelmingly common one.
 *
 * **Why this reports rather than repairs.** The three things it could do instead are all worse.
 *
 * *Re-sign them under the new key.* The tempting one, and unsound. A peer id here **is** an
 * Ed25519 public key; an event id is `(peerId, seqNum, local)`; and every per-author CRDT — the
 * PN-counter above, every last-writer-wins stamp — is keyed by author. Re-signing is therefore
 * not re-signing, it is re-authoring: it mints a second event id for a write that already
 * folded, under a sequence number that collides with the new identity's own run, and where the
 * original did reach a peer before the rotation, both copies now exist and a counter adds them
 * up twice. The bug that made this visible, doubled instead of halved. It is also a lie about
 * who wrote what, in a log whose only claim to being worth anything is that it is not.
 *
 * *Drop them.* They folded. The rows are on the screen. Deleting the events beneath them makes
 * the device unable to explain its own state and unable to serve it, and gains nothing, because
 * the state was never the part that was missing.
 *
 * *Refuse to open.* A device that will not boot is worse than a device that boots and says what
 * is wrong with it, and the databases this has already happened to are exactly the ones that
 * would be bricked by it. The refusal belongs one layer up, before a rotation, where it is still
 * a choice — and this is what that layer needs in order to know.
 *
 * So: name them, and let the rotation be refused or the loss be accepted deliberately.
 */
export function strandedWrites(
  store: EventStore,
  mine: PeerId,
): Promise<Result<readonly StrandedWrites[], StoreFailure>> {
  return store.stranded(mine).then((found) => found.map(runsOf));
}

interface Run {
  readonly count: number;
  readonly from: SeqNum;
  readonly to: SeqNum;
}

/** The stranded entries grouped into one run per author, each named as the error it is. */
function runsOf(entries: readonly StoredEvent[]): readonly StrandedWrites[] {
  const runs = new Map<PeerId, Run>();
  for (const { event } of entries) {
    const held = runs.get(event.peerId);
    runs.set(
      event.peerId,
      held === undefined
        ? { count: 1, from: event.seqNum, to: event.seqNum }
        : {
            count: held.count + 1,
            from: event.seqNum < held.from ? event.seqNum : held.from,
            to: event.seqNum > held.to ? event.seqNum : held.to,
          },
    );
  }
  return [...runs].map(
    ([author, run]) =>
      new StrandedWrites({
        author,
        ...run,
        message:
          `${run.count} event(s) by ${author.slice(0, 8)} (seq ${run.from}-${run.to}) can never be sent: ` +
          `this device holds no signature for them and no key here can make one. They fold locally and ` +
          `reach no peer — what a device key rotated over a kept log leaves behind.`,
      }),
  );
}
