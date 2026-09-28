/**
 * What this radio decided about one advertisement, and which rung decided it.
 *
 * Discovery on BLE is six judgements in a row, and until this existed every one of them was a
 * bare `return`. That made the whole of "nobody is finding anybody" report as silence — the
 * transport says `ok`, it reaches nothing, and no line anywhere distinguishes *our fleet is not
 * in the air* from *we saw them and it is their turn to dial* from *we tried and are backing
 * off*. Those are three different bugs in three different places, and a person holding two
 * phones cannot tell them apart by looking at the phones.
 *
 * So the rung is the finding. A verdict that is not `dialling` is not a failure — four of the
 * six are this medium working exactly as designed — which is why these are sightings rather than
 * drops, and why a caller is expected to report a *change* of verdict rather than every one.
 */
export type BleVerdict =
  /**
   * It put something in the air and none of it was ours to read — another vendor's device.
   *
   * Distinct from {@link BleVerdict} `dialling-unnamed`, and the distinction is the whole of what
   * keeps this safe: a peripheral announcing `AirPods` **said a name**, it just was not a hint. A
   * backgrounded iPhone says nothing at all.
   */
  | "unreadable"
  /** Our own advertisement, echoed back — which some platforms do. Dialling it is a link to self. */
  | "self"
  /** Carried a group tag, and it was not ours. The one refusal BLE can make before spending a dial. */
  | "another-fleet"
  /** Seen already and still within its TTL: a peer re-advertises about once a second. */
  | "already-known"
  /** Theirs to dial. Exactly one end connects; this one waits to be written to. */
  | "theirs-to-dial"
  /** A dial to this peer failed recently and the backoff has not run out. */
  | "backing-off"
  /** Nothing refused it: a connection is being opened. */
  | "dialling"
  /**
   * Dialled on the peripheral id alone, because the advertisement named nobody.
   *
   * **A backgrounded iPhone is this.** iOS ignores `CBAdvertisementDataLocalNameKey` while an app
   * is in the background and cannot advertise service data at any time, so both fields the hint
   * could travel in are empty; the service uuid moves to a private overflow area that a scanner
   * matches on but cannot read back. What arrives is a peripheral id and nothing else.
   *
   * Dialling it anyway is sound because **the scan filter is the proof**: this callback only
   * fires for a device advertising our service uuid, which is the same thing the hint was ever
   * evidence of. What is lost without a name is only `shouldDial`, and losing it is the right way
   * round — the end that could not announce itself is the backgrounded one, whose own scanning is
   * throttled to the point where it will not dial us. So this end must.
   *
   * **Silence is the test, not unreadability.** A device that announced *something* unreadable is
   * somebody else's and stays refused: on Android the local name survives backgrounding, so a
   * nameless advertisement is not an Android peer, and Android will hand a scanner results its
   * own filter excluded whenever another app is scanning unfiltered. Dialling on "no hint" rather
   * than on "no announcement" would spend a connection on every headphone in the room.
   *
   * Identity is unaffected. A hint never established it; the handshake does, exactly as it does
   * for every other verdict, so a dial at the wrong device costs one connection and proves nobody.
   */
  | "dialling-unnamed";

/** One advertisement judged, as a caller reports it. */
export interface BleSighting {
  /** The advertisement's hint — a lossy derivation of a peer id, and all an advert has room for. */
  readonly hint: string | undefined;
  readonly peripheralId: string;
  readonly verdict: BleVerdict;
}

/**
 * The rungs, in the order a scan result meets them.
 *
 * Thunks rather than values because two of them **record** as they answer: `fresh` is what enters
 * the sighting into discovery, and asking it about an advertisement that was already refused
 * higher up would keep a stranger's phone alive in our own table.
 */
export interface Rungs {
  /** Whether the advertisement carried any identifying field at all, hint-shaped or not. */
  readonly announced: () => boolean;
  readonly ours: () => boolean;
  readonly fresh: () => boolean;
  readonly mine: () => boolean;
  readonly ready: () => boolean;
}

/**
 * The verdict, and the rung that reached it.
 *
 * An unnamed advertisement is judged by every rung a named one is, bar the two that need a name:
 * `self`, which compares hints, and `mine`, which is `shouldDial`. It is not skipped — see
 * `dialling-unnamed` for why a peer that announced nothing is still worth a connection.
 */
export const judge = (hint: string | undefined, self: string, rungs: Rungs): BleVerdict => {
  if (hint === self) return "self";
  if (!rungs.ours()) return "another-fleet";
  if (hint === undefined && rungs.announced()) return "unreadable";
  if (!rungs.fresh()) return "already-known";
  if (hint !== undefined && !rungs.mine()) return "theirs-to-dial";
  if (!rungs.ready()) return "backing-off";
  return hint === undefined ? "dialling-unnamed" : "dialling";
};
