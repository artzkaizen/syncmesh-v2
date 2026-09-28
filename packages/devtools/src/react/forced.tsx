import type { ForcedMedium } from "@syncmesh/client";

import { useEffect, useState } from "react";

import type { DevtoolsControls } from "../controls.js";

import { RADIUS, SEVERITY_COLOR, SEVERITY_TINT, SPACE, TEXT } from "../tokens.js";

/**
 * A forced state has to be visible where the app is, not only where the panel is.
 *
 * This is the predictable failure and it is worth spelling out: a developer holds `ble` in
 * `radio-off` to see what the panel draws, closes the inspector, comes back after lunch and files
 * a bug against "sync is broken". Nothing about the app looks wrong, because nothing about the app
 * *is* wrong — a medium is switched off, which is a thing that happens to real devices.
 *
 * So the mark is drawn in three places, in descending order of how little work the host has to do.
 * The bubble carries one automatically, which costs nothing on an app that passed no controls,
 * because there is nothing to subscribe to. {@link ForcedBadge} is the same fact as a pill a host
 * can put in its own header beside the storage badge that already names its mode there. And under
 * both, `mesh.status.get()` reports the forced condition per source and goes `offline` when
 * nothing is left carrying — so an app with its own status UI says it without importing any of
 * this.
 */

/**
 * The held mediums, re-read after every action that went through `controls`.
 *
 * Subscribes to nothing when `controls` is absent, which is what keeps a shut inspector free in a
 * build that ships no controls: there is no hub, no timer and no mesh subscription behind this.
 */
export function useForced(controls: DevtoolsControls | undefined): readonly ForcedMedium[] {
  const [held, setHeld] = useState<readonly ForcedMedium[]>(() => controls?.forced() ?? []);
  useEffect(() => {
    if (controls === undefined) {
      setHeld([]);
      return;
    }
    setHeld(controls.forced());
    return controls.onChange(() => setHeld(controls.forced()));
  }, [controls]);
  return held;
}

/** One sentence, naming every held medium, because "something is forced" sends nobody anywhere. */
export const forcedDetail = (held: readonly ForcedMedium[]): string =>
  `The inspector is holding ${held.map((one) => `${one.name} in ${one.as}`).join(", ")}. ` +
  `This device is not using ${held.length === 1 ? "that medium" : "those mediums"}, and syncing ` +
  `over ${held.length === 1 ? "it" : "them"} will not resume until it is released here or the page is reloaded.`;

/** Short enough for a header strip: the count, or the one name when there is only one. */
export const forcedLabel = (held: readonly ForcedMedium[]): string =>
  held.length === 1 && held[0] !== undefined
    ? `${held[0].name} forced ${held[0].as}`
    : `${held.length} mediums forced`;

export interface ForcedBadgeProps {
  readonly controls: DevtoolsControls | undefined;
}

/**
 * The pill for a host's own chrome, drawn only when something is held.
 *
 * Amber rather than red: a held medium is a deliberate act whose only failure mode is being
 * forgotten, and an app whose header goes red every time somebody opens the inspector is an app
 * whose header nobody reads. Inline styles, so it survives being rendered outside the panel's
 * shadow root and into whatever the host's own stylesheet is doing.
 */
export function ForcedBadge({ controls }: ForcedBadgeProps) {
  const held = useForced(controls);
  if (held.length === 0) return null;
  const color = SEVERITY_COLOR.high;
  return (
    <span
      style={{
        alignItems: "center",
        background: SEVERITY_TINT.high,
        border: `1px solid ${color}33`,
        borderRadius: RADIUS.pill,
        color,
        display: "inline-flex",
        gap: SPACE.xs,
        padding: `2px ${String(SPACE.sm)}px`,
        ...TEXT.xs,
      }}
      title={forcedDetail(held)}
    >
      <span style={{ background: color, borderRadius: RADIUS.pill, height: 5, width: 5 }} />
      {forcedLabel(held)}
    </span>
  );
}
