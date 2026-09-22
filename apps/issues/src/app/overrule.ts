import type { OperationRecord } from "@syncmesh/react";

import { useEffect, useRef } from "react";

/**
 * A write this screen was watching has been overruled, said once, over whatever is on screen.
 *
 * The record is `useOperation`'s; this reads it and nothing else. The store underneath is the
 * app's — a list of lines and who is watching it — because a toast is drawn above every route
 * and the record that caused it lives inside one.
 */

/** One line the app says over the screen, and goes quiet about by itself. */
export interface Toast {
  readonly id: string;
  readonly text: string;
}

/** Long enough to read a reason; short enough that a board is not wearing it a minute later. */
const SHOWN_MS = 8_000;

let shown: readonly Toast[] = [];
const watchers = new Set<() => void>();
const said = new Set<string>();

const notify = (): void => {
  for (const watch of watchers) watch();
};

/** The lines currently up; the same array until one comes or goes. */
export const toasts = (): readonly Toast[] => shown;

export function onToasts(listener: () => void): () => void {
  watchers.add(listener);
  return () => void watchers.delete(listener);
}

export function dismiss(id: string): void {
  if (!shown.some((toast) => toast.id === id)) return;
  shown = shown.filter((toast) => toast.id !== id);
  notify();
}

/** Says it once per id, however many components hold the record it is about. */
export function announce(id: string, text: string): void {
  if (said.has(id)) return;
  said.add(id);
  shown = [...shown, { id, text }];
  notify();
  setTimeout(() => dismiss(id), SHOWN_MS);
}

/** What the toast says about a correction. */
export const overruledBy = (reason: string): string => `changed by the office: ${reason}`;

/**
 * "changed by the office: <reason>", the moment a write this screen is watching is overruled.
 *
 * *Gains*, not *has*: a record that arrives already corrected is the badge's to draw and this
 * says nothing about it; a record seen without a correction and then with one is news, and this
 * is the toast for it.
 */
export function useOverruled(record: OperationRecord | undefined): void {
  const uncorrected = useRef<string>(undefined);
  useEffect(() => {
    if (record === undefined) return;
    if (record.correction === undefined) {
      uncorrected.current = record.id;
      return;
    }
    if (uncorrected.current === record.id)
      announce(record.id, overruledBy(record.correction.reason));
    uncorrected.current = undefined;
  }, [record]);
}
