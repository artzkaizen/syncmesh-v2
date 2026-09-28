import { useEffect, useState } from "react";

import type { Reach, Reaching } from "./reach.js";

import { watchReach } from "./reach.js";
import { COLOR, RADIUS, SEVERITY_COLOR, SEVERITY_TINT, SPACE, TEXT } from "./ui.js";

/**
 * **Whether this device is reaching the relay, on screen, always.**
 *
 * The third of the three badges this app draws for the same reason as the other two: the degraded
 * case is invisible. A relay that is not running looks exactly like a relay that is — writes
 * commit, queries return, the board scrolls — right up until somebody opens the app in a second
 * browser and waits for a change that is never coming. So the medium's own condition is drawn, and
 * the degraded case is coloured like the problem it is.
 *
 * **It names the device too**, which the storage and role badges do not need to. Two installs that
 * present the same `peerId` are one author publishing two divergent sequence streams into one log,
 * and the failure mode is not an error — it is writes discarded as already-seen. Showing the id is
 * how a person checks, in the two seconds it takes to compare two windows, that the thing this app
 * calls two devices really is two.
 *
 * It sits in the corner rather than in the header strip only because `chrome.tsx` is being
 * rewritten around the router as this lands; it is built as a header pill and moving it beside
 * {@link StorageBadge} is one line.
 */

interface Mode {
  readonly label: string;
  readonly detail: string;
  readonly severity: "ok" | "high" | "critical";
}

const MODE = {
  off: {
    label: "Local only",
    detail:
      "This build dials no relay (VITE_RELAY_URL is empty), so this install converges with nothing. Every read and write is still local and still durable — that is the product, not a fallback.",
    severity: "ok",
  },
  reaching: {
    label: "Relay — dialling",
    detail:
      "The socket is open and the relay has not answered the join yet. This is the first moment of a boot and should not last; if it does, the address is answering and not speaking the relay protocol.",
    severity: "high",
  },
  online: {
    label: "Relay",
    detail:
      "The relay answered this device's join and is carrying its room. A write here reaches every other install on the same relay, and one made while it was down is sent when it comes back — nothing on this screen depends on it.",
    severity: "ok",
  },
  unreachable: {
    label: "Relay unreachable",
    detail:
      "This device is dialling a relay that is not answering, and is retrying with backoff. Everything works: the app is local-first, so reads and writes are unaffected and queued events go out when it returns. What does not happen until then is convergence with another install. Start it with `bun run --cwd apps/issues relay`.",
    severity: "critical",
  },
} satisfies Record<Reaching, Mode>;

/** Enough of a peer id to tell two installs apart by eye, and few enough to sit in a pill. */
const SHORT = 8;

export function ReachBadge() {
  const [reach, setReach] = useState<Reach>();

  useEffect(() => watchReach(setReach), []);

  // nothing until the worker has said something: a pill that guessed would be the one surface here
  // that is not a fact, and this one exists because guessing is what the rest of the app cannot do
  if (reach === undefined) return null;
  const mode = MODE[reach.state];
  const color = SEVERITY_COLOR[mode.severity];
  const lines = [mode.detail, reach.url, reach.why].filter((line) => line !== undefined);
  return (
    <span
      data-device={reach.device}
      data-reach={reach.state}
      style={{
        alignItems: "center",
        background: SEVERITY_TINT[mode.severity],
        border: `1px solid ${color}33`,
        borderRadius: RADIUS.pill,
        bottom: SPACE.lg,
        color,
        display: "inline-flex",
        gap: SPACE.xs,
        left: SPACE.lg,
        padding: `2px ${String(SPACE.sm)}px`,
        position: "fixed",
        ...TEXT.xs,
      }}
      title={lines.join("\n\n")}
    >
      <span style={{ background: color, borderRadius: RADIUS.pill, height: 5, width: 5 }} />
      {mode.label}
      <span style={{ color: COLOR.textFaint, fontVariantNumeric: "tabular-nums" }}>
        {reach.device.slice(0, SHORT)}
      </span>
    </span>
  );
}
