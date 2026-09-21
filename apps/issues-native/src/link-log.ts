import type { BleSighting } from "@syncmesh/ble";
import type { MeshStatus } from "@syncmesh/client";
import type { LinkEvent, Transport } from "@syncmesh/transport";

/**
 * What each medium is actually doing, in the log, on both phones at once.
 *
 * The app logged one thing about BLE — the reason a link ended — which is the last line of a story
 * and none of the rest of it. "Bluetooth is not transferring the information" is a sentence about
 * at least five different failures, and `dropped: the medium closed this link` distinguishes none
 * of them: nobody was found; somebody was found and never dialled; a dial that never connected; a
 * connection whose handshake was refused; a proven link that carried nothing.
 *
 * Two phones both point their console at one Metro, so a line from each lands in one file with the
 * other's, and the peer prefix is what tells them apart. That is the whole reason this is a log
 * line rather than a devtools panel: the failure is *between* two devices, and a panel can only
 * ever show one of them.
 *
 * ## Reading it
 *
 * - `[link] 3f9c1e22 · ble proven peer=4a825aca` — a handshake completed. Below this line, none had.
 * - `[link] … ble refused … why=…` — a peer was found and turned away, with the rung that did it.
 * - `[link] … ble closed peer=… why=…` — a link that existed has ended.
 * - `[mesh] 3f9c1e22 · ble ok reaches 1 · relay unreachable · folded 1449` — the standing picture,
 *   printed only when it changes, so a quiet mesh is quiet in the log too.
 *
 * A pair that never prints `proven` on either phone has a discovery or a dial problem. A pair that
 * prints `proven` and never moves `folded` has a link that formed and carried nothing, which is a
 * different bug in a different file. Those are the two halves this exists to tell apart.
 */

/** The head of a peer id: enough to tell two devices apart, short enough to read in a log. */
const shortly = (peer: string | undefined): string => (peer ?? "?").slice(0, 8);

/** What this device has taken in, split the only way that tells a broken link from a refused one. */
interface Took {
  /** Folded from this device's own writes. Moves whether or not anything is reachable. */
  readonly mine: number;
  /**
   * Folded from a peer — the number that says a link actually carried something.
   *
   * Zero here while the other phone is writing is a **delivery** failure: nothing arrived. Nonzero
   * while the screen does not change is a different bug entirely, and `parked` tells them apart.
   */
  readonly theirs: number;
  /** Arrived and was refused by validation. A grant problem looks like this, not like silence. */
  readonly parked: number;
}

/** What the mesh looks like right now, as the one line worth repeating. */
const picture = (status: MeshStatus, media: readonly Transport[], took: Took): string => {
  const sources = [...status.sources].map(([name, source]) => {
    const reaches = media.find((one) => one.name === name)?.reaches?.().size;
    return `${name} ${source.condition}${reaches === undefined ? "" : ` reaches ${String(reaches)}`}`;
  });
  return `${sources.join(" · ")} · folded ${String(took.mine)} mine / ${String(took.theirs)} theirs · parked ${String(took.parked)}`;
};

/** The slice of a running client this reads. Stated so nothing here can reach past it. */
export interface Watched {
  readonly $transports: {
    readonly list: () => readonly Transport[];
    readonly onLinkEvent: (listener: (event: LinkEvent) => void) => () => void;
  };
  readonly $status: { readonly get: () => MeshStatus };
  readonly $mesh: {
    readonly engine: {
      readonly onFoldBatch: (
        listener: (batch: { readonly source: string; readonly eventCount: number }) => void,
      ) => () => void;
      /** Refused by validation and parked — arrived, and never folded. */
      readonly onQuarantine: (
        listener: (parked: {
          readonly event: { readonly peerId: string; readonly procedure: string };
          readonly reason: { readonly _tag?: string; readonly message?: string };
        }) => void,
      ) => () => void;
    };
  };
}

/** How often the standing picture is taken. It is *printed* only when it differs from the last. */
const EVERY_MS = 2000;

/**
 * Starts reporting, and hands back the function that stops it — call it where the mesh is closed,
 * or a Fast Refresh leaves a timer running against a replica nobody holds.
 */
export function watchLinks(app: Watched, self: string): () => void {
  const me = shortly(self);

  const offLinks = app.$transports.onLinkEvent((event) => {
    const who = event.peer === undefined ? "" : ` peer=${shortly(String(event.peer))}`;
    const why = event.why === undefined ? "" : ` why=${event.why}`;
    // eslint-disable-next-line no-console -- a phone has no other place to put this, and the
    // failure being diagnosed is between two of them
    console.log(`[link] ${me} · ${event.transport} ${event.kind}${who}${why}`);
  });

  /**
   * What has been taken in since launch, split by where it came from.
   *
   * `source` is the fold's own word for it: `local` is this device writing, anything else came off
   * a link. Counting them together — which is what the first version of this did — cannot answer
   * the question actually being asked, because a device that writes happily and receives nothing
   * looks identical to one that is fully caught up.
   */
  let mine = 0;
  let theirs = 0;
  let parked = 0;
  const offFolds = app.$mesh.engine.onFoldBatch((batch) => {
    if (batch.source === "local") mine += batch.eventCount;
    else theirs += batch.eventCount;
  });
  const offParked = app.$mesh.engine.onQuarantine(({ event, reason }) => {
    parked += 1;
    // eslint-disable-next-line no-console -- an event that arrived and was refused is the one
    // failure that looks exactly like an event that never arrived, and only this can tell them apart
    console.log(
      `[parked] ${me} · from ${shortly(String(event.peerId))} ${String(event.procedure)} why=${reason._tag ?? reason.message ?? "?"}`,
    );
  });

  let said = "";
  const timer = setInterval(() => {
    const now = picture(app.$status.get(), app.$transports.list(), { mine, parked, theirs });
    if (now === said) return;
    said = now;
    // eslint-disable-next-line no-console -- see above; printed only on change, so a settled mesh
    // stops talking instead of filling the log
    console.log(`[mesh] ${me} · ${now}`);
  }, EVERY_MS);

  return () => {
    offLinks();
    offFolds();
    offParked();
    clearInterval(timer);
  };
}

/**
 * One line per *change* of verdict about a peer in the air.
 *
 * A phone advertises about once a second and every one of those is judged, so reporting each
 * would bury the log in `already-known`. What is worth saying is the transition: a peer that
 * appeared, a peer whose turn it became to dial, a peer that started backing off. A fleet that
 * finds nobody prints nothing at all here — and *that* is the finding, against a `[mesh]` line
 * claiming the radio is `ok`.
 */
export function reportSightings(self: string): (sighting: BleSighting) => void {
  const me = shortly(self);
  const said = new Map<string, string>();
  return ({ hint, peripheralId, verdict }) => {
    const who = hint ?? peripheralId;
    if (said.get(who) === verdict) return;
    said.set(who, verdict);
    // eslint-disable-next-line no-console -- the whole point: a device that finds nobody has to
    // be able to say which rung refused, and two phones share one console
    console.log(`[air] ${me} · ${shortly(hint) === "?" ? "unreadable" : shortly(hint)} ${verdict}`);
  };
}
