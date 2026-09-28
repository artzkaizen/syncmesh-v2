import type { MeshHealth, OperationsView } from "@syncmesh/client";
import type { LinkEvent, LinkEventKind, TransportCondition } from "@syncmesh/transport";
import type { ChipColor } from "heroui-native";

import Constants from "expo-constants";

import type { Instruments } from "./mesh";

/**
 * The mesh's own vocabulary, turned into the words and colours a row draws.
 *
 * Separate from the screen because none of it is layout: a condition becoming a sentence, an
 * ending becoming a verb, a ledger row becoming an age. Keeping it here is what lets the screen
 * be a list of `ListGroup`s and nothing else, and it is where a wording gets corrected once
 * rather than in whichever of six rows happened to say it.
 *
 * **Nothing here invents a number.** The one fact a person most wants — *when did this medium
 * last carry a frame* — is not observable from outside a transport: `Transport` reports link
 * endings and a condition, and a frame arriving is neither. So the panel says what it can see,
 * which is when the medium last *said* anything, and the sharper evidence of a dead-but-confident
 * link is elsewhere: writes piling up unacknowledged while the condition still reads `ok`.
 */

/**
 * Coarse on purpose: a reader wants "2m" and "3h", not a duration to the millisecond.
 *
 * Deliberately the same spellings as `since` in `@syncmesh/devtools`' `panels/link-kit.tsx`, so a
 * phone and a laptop looking at one mesh do not disagree about how long ago something was. That
 * package cannot be imported here — its entry point is one module with `@syncmesh/browser` and
 * the DOM in it, and this app consumes `dist` like any other consumer.
 */
export const since = (atMs: number, nowMs: number): string => {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/** What a source is doing, or why it is not — the book's per-source vocabulary as sentences. */
const CONDITION_NOTE = {
  ok: "carrying",
  "connecting-failed": "cannot connect, so nothing is reaching it",
  "listen-failed": "could not listen, so nothing can reach this device over it",
  "discovery-failed": "cannot look for peers",
  "radio-off": "the radio is switched off",
  "no-permission-central": "not allowed to scan for peers",
  "no-permission-peripheral": "not allowed to advertise to peers",
  "no-hardware": "there is no radio here",
  backgrounded: "asleep while the app is in the background",
  "temporarily-unavailable": "away, and being retried",
  unknown: "nothing has happened on it yet",
} satisfies Record<TransportCondition, string>;

/**
 * The same severities `@syncmesh/devtools` gives a condition, in this library's colour names.
 *
 * `no-hardware` and `unknown` stay grey because neither is a fault: a simulator has no radio, and
 * a socket that has not been dialled yet has not failed. A panel where every row shouts is one
 * nobody reads twice.
 */
const CONDITION_TONE = {
  ok: "success",
  "connecting-failed": "danger",
  "listen-failed": "danger",
  "discovery-failed": "warning",
  "radio-off": "warning",
  "no-permission-central": "danger",
  "no-permission-peripheral": "danger",
  "no-hardware": "default",
  backgrounded: "warning",
  "temporarily-unavailable": "warning",
  unknown: "default",
} satisfies Record<TransportCondition, ChipColor>;

/** An ending as the thing that happened, so a feed reads as sentences rather than as enum names. */
const ENDING_WORD = {
  proven: "proved itself",
  refused: "was refused",
  closed: "closed",
  dropped: "dropped a frame",
  error: "errored",
} satisfies Record<LinkEventKind, string>;

/** A refusal is the ending worth colouring; a close is ordinary, and a peer walking away is not news. */
const ENDING_TONE = {
  proven: "success",
  refused: "danger",
  closed: "default",
  dropped: "warning",
  error: "danger",
} satisfies Record<LinkEventKind, ChipColor>;

const HEALTH_NOTE = {
  opening: "this device's own database is still opening — nothing has been read yet",
  "local-ready": "every source has finished its first pass",
  "catching-up": "a source is still handing things over",
  offline: "no source is carrying — reads still come out of this device's own log",
  "blocked-recovery": "something is stuck and an operator has to act",
} satisfies Record<MeshHealth, string>;

const HEALTH_TONE = {
  opening: "warning",
  "local-ready": "success",
  "catching-up": "warning",
  offline: "danger",
  "blocked-recovery": "danger",
} satisfies Record<MeshHealth, ChipColor>;

export const healthNote = (health: MeshHealth): string => HEALTH_NOTE[health];
export const healthTone = (health: MeshHealth): ChipColor => HEALTH_TONE[health];
export const endingTone = (kind: LinkEventKind): ChipColor => ENDING_TONE[kind];

/** One ending as a line: what happened, and the medium's own reason where it gave one. */
export const endingLine = (event: LinkEvent): string =>
  event.why === undefined ? ENDING_WORD[event.kind] : `${ENDING_WORD[event.kind]}: ${event.why}`;

/** One medium, with everything a row about it draws. */
export interface Reading {
  /** The transport's own name — the same one `$status` and the link feed key by. */
  readonly name: string;
  readonly kind: string;
  readonly condition: TransportCondition;
  readonly note: string;
  readonly tone: ChipColor;
  /**
   * The last thing this medium said, ever — `undefined` when it has said nothing since launch.
   *
   * **Not "the last frame it carried".** A transport reports endings, not traffic, so a link that
   * proved itself at launch and has been dead for four minutes looks exactly like one that proved
   * itself at launch and is fine. That is why the row says *last said* rather than *last heard*,
   * and why the writes section beside it is the one that catches a dead socket.
   */
  readonly said: LinkEvent | undefined;
  /**
   * Telling this medium to look again, where it has a door for it — `Transport.wake`.
   *
   * Absent on a medium with no link that can go stale without saying so, which is a fact about
   * the medium rather than a missing feature — so the row draws nothing rather than a dead button.
   */
  readonly wake: (() => void) | undefined;
  /** How many links this medium sustains at once; `undefined` where there is no limit worth naming. */
  readonly maxLinks: number | undefined;
  /** How near this source is (RFC-0019): 0 is local storage, 1 a relay, 2 a radio. */
  readonly priority: number;
}

/**
 * Every medium attached right now, newest reading each time.
 *
 * `condition` is read from `$status` rather than from the transport, because that is where the
 * inference lives for a medium that declares none — up means `ok`, down means
 * `temporarily-unavailable` — and two places computing it is two places to disagree.
 */
export function readings(instruments: Instruments): readonly Reading[] {
  const { sources } = instruments.status();
  const endings = instruments.endings();
  return instruments.media().map((transport) => {
    const source = sources.get(transport.name);
    const condition = source?.condition ?? transport.condition?.() ?? "unknown";
    return {
      name: transport.name,
      kind: source?.kind ?? transport.kind ?? "unknown",
      condition,
      note: CONDITION_NOTE[condition],
      tone: CONDITION_TONE[condition],
      said: endings.find((event) => event.transport === transport.name),
      wake: transport.wake?.bind(transport),
      maxLinks: transport.maxLinks?.(),
      // RFC-0019's default, said once here rather than left for each row to guess at
      priority: transport.priority ?? 1,
    };
  });
}

/** One write of this device's that nobody has receipted. */
export interface WaitingWrite {
  readonly id: string;
  /** The procedure that made it, as the ledger recorded it — `issues.move`, not an event id. */
  readonly label: string;
  readonly atMs: number;
  readonly status: string;
}

/** What the ledger says is still in flight, and the honest shape of it refusing to say. */
export interface Waiting {
  readonly rows: readonly WaitingWrite[];
  /**
   * How many there are, against however many {@link readWaiting} was asked to return.
   *
   * A list that quietly stopped at ten reads as "ten writes are waiting", which is a different
   * sentence from the truth — the same reason `@syncmesh/devtools`' writes reader carries a
   * `truncated` flag beside its rows.
   */
  readonly total: number;
  /** Why there is nothing to show, where that is a refusal rather than an empty queue. */
  readonly refused: string | undefined;
}

/**
 * This device's unacknowledged writes, oldest first.
 *
 * **The sharpest reading on the screen.** `unsettled()` is *nobody has confirmed holding this*, so
 * a growing list beside a relay whose condition still reads `ok` is a link that believes in itself
 * and is carrying nothing — which is exactly what an abandoned socket looks like for the ~37
 * seconds before its keepalive deadline notices. No other reading here can show that, because
 * every other one is the transport's own opinion of itself.
 */
export async function readWaiting(
  writes: OperationsView | undefined,
  limit: number,
): Promise<Waiting> {
  if (writes === undefined)
    return { refused: "this mesh keeps no write ledger", rows: [], total: 0 };
  const held = await writes.unsettled();
  if (held.isErr())
    return {
      // the ledger's own words where it brought any, which is what `./mesh`'s `because` does with
      // a cause — a screen that said only "the ledger refused" would leave nothing to act on
      refused: held.error instanceof Error ? held.error.message : "the ledger would not answer",
      rows: [],
      total: 0,
    };
  return {
    refused: undefined,
    rows: held.value.slice(0, limit).map((row) => ({
      atMs: row.atMs,
      id: row.id,
      label: row.label,
      status: row.status,
    })),
    total: held.value.length,
  };
}

/** The keys under `extra` this build actually reads, so the section cannot drift from `app.json`. */
const EXTRA_KEYS = ["relayUrl", "authorityUrl", "bluetooth"] as const;

/**
 * A declared value as it would be written down, with an absent one said out loud.
 *
 * `undefined` and `false` are the two answers this section exists to tell apart: a key nobody set
 * and a key somebody set to off look identical from inside the app, and only one of them is a line
 * in `app.json` waiting to be changed.
 *
 * Anything that is not a primitive is printed as its JSON rather than described, because the one
 * case that actually turns up is a surprise worth seeing verbatim: **a `null` in `app.json` reaches
 * the runtime as `{}`**. Expo serialises it that way through the manifest — measured on this
 * device, not assumed — so a row reading `{}` is a key that was written as `null`, and a screen
 * that said "not printable" would have hidden exactly that.
 */
const declared = (value: unknown): string => {
  if (value === undefined) return "not declared";
  if (typeof value === "string") return value === "" ? "an empty string" : value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value) ?? "not printable";
};

/** One declared build flag, and what this build read out of it. */
export interface Flag {
  readonly key: string;
  readonly value: string;
}

/**
 * `extra` from `app.json`, exactly as this build read it.
 *
 * **This is the section that would have cost an afternoon.** BLE is gated behind
 * `extra.bluetooth` — see `permitted` in `./ble`, and the CoreBluetooth abort it exists to
 * avoid — and a build with it off has one fewer transport and says nothing at all about why.
 * Nothing on the device showed the flag; it was found by reading the source. Printing what was
 * declared, beside a transports list that shows what was actually built, makes the two answerable
 * against each other at a glance.
 */
export function buildFlags(): readonly Flag[] {
  // Expo's config arrives through a native runtime typed `any`, so it is narrowed where it lands
  // rather than trusted — the same rule `./mesh` follows with its `Address` schema
  const extra: unknown = Constants.expoConfig?.extra;
  const held =
    typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>) : {};
  return EXTRA_KEYS.map((key) => ({ key, value: declared(held[key]) }));
}
