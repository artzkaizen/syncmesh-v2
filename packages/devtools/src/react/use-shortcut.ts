import { useEffect } from "react";

import { documentOf } from "../dom.js";

/**
 * The one thing this package listens to while the panel is closed.
 *
 * A single passive `keydown` on the document, registered once, doing a string comparison and
 * returning — that is the entire standing cost of having the devtools installed and shut. It has
 * to exist, because a bubble in a corner is findable only if you are looking at that corner, and
 * the whole point of a shortcut is that you are not.
 */

export interface Shortcut {
  /** Compared case-insensitively against `KeyboardEvent.key`. */
  readonly key: string;
  readonly alt?: boolean | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
  readonly shift?: boolean | undefined;
}

/**
 * Ctrl+Shift+D, and not a Cmd combination: on macOS every Cmd+letter is either the browser's or
 * the app's, and a devtool has no business taking one of those.
 */
export const DEFAULT_SHORTCUT = { key: "d", ctrl: true, shift: true } satisfies Shortcut;

/** For the bubble's tooltip: a shortcut nobody is told about is not a shortcut. */
export function formatShortcut(shortcut: Shortcut): string {
  const parts = [
    shortcut.ctrl === true ? "Ctrl" : undefined,
    shortcut.meta === true ? "Cmd" : undefined,
    shortcut.alt === true ? "Alt" : undefined,
    shortcut.shift === true ? "Shift" : undefined,
    shortcut.key.toUpperCase(),
  ];
  return parts.filter((part) => part !== undefined).join("+");
}

/**
 * Bound on the fields rather than on the object, so an app that writes the shortcut inline in JSX
 * does not tear the listener down and put it back on every render of its tree.
 *
 * Pass `undefined` to bind nothing, for an app whose own keymap already reaches the toggle.
 */
export function useShortcut(shortcut: Shortcut | undefined, fire: () => void): void {
  const key = shortcut?.key;
  const alt = shortcut?.alt ?? false;
  const ctrl = shortcut?.ctrl ?? false;
  const meta = shortcut?.meta ?? false;
  const shift = shortcut?.shift ?? false;
  useEffect(() => {
    const doc = documentOf();
    if (doc === undefined || key === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const hit =
        event.key.toLowerCase() === key.toLowerCase() &&
        event.altKey === alt &&
        event.ctrlKey === ctrl &&
        event.metaKey === meta &&
        event.shiftKey === shift;
      if (!hit) return;
      event.preventDefault();
      fire();
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => {
      doc.removeEventListener("keydown", onKeyDown);
    };
  }, [key, alt, ctrl, meta, shift, fire]);
}
