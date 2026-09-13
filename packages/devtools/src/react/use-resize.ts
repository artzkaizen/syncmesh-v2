import type { KeyboardEvent, PointerEvent } from "react";

import { useCallback, useEffect, useState } from "react";

import type { Dock } from "../state.js";

import { windowOf } from "../dom.js";
import { clampSize, sizeFromPointer } from "../state.js";

/**
 * The drag that resizes the panel, on pointer capture rather than window listeners.
 *
 * Capture keeps every move event on the grip itself, which means the drag survives the pointer
 * crossing an iframe, a canvas, or anything else in the host page that would otherwise swallow it
 * — and it means this hook installs nothing globally, so a panel that is closed has no listener
 * anywhere. Arrow keys move the edge too: the grip is focusable, and a 1px-tall drag target is
 * exactly the control a keyboard user cannot reach.
 */

/** How far one arrow press moves the edge. Shift multiplies it, as it does everywhere else. */
const STEP = 16;

export interface ResizeHandle {
  readonly dragging: boolean;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

const extent = (dock: Dock, view: Window) =>
  dock === "bottom" ? view.innerHeight : view.innerWidth;

/**
 * How much room there is along the docked axis, remeasured as the window changes.
 *
 * Only mounted while the panel is open, which is why it is a `resize` listener and not a stored
 * number: a closed devtool has nothing to measure and registers nothing.
 */
export function useViewportExtent(dock: Dock): number | undefined {
  const [measured, setMeasured] = useState<number | undefined>(undefined);
  useEffect(() => {
    const view = windowOf();
    if (view === undefined) return;
    const measure = () => setMeasured(extent(dock, view));
    measure();
    view.addEventListener("resize", measure);
    return () => {
      view.removeEventListener("resize", measure);
    };
  }, [dock]);
  return measured;
}

export function useResize(dock: Dock, size: number, onSize: (size: number) => void): ResizeHandle {
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const view = windowOf();
      if (!dragging || view === undefined) return;
      const pointer = dock === "bottom" ? event.clientY : event.clientX;
      onSize(sizeFromPointer(pointer, extent(dock, view)));
    },
    [dragging, dock, onSize],
  );

  const onPointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const grow = dock === "bottom" ? "ArrowUp" : "ArrowLeft";
      const shrink = dock === "bottom" ? "ArrowDown" : "ArrowRight";
      if (event.key !== grow && event.key !== shrink) return;
      event.preventDefault();
      const view = windowOf();
      const step = STEP * (event.shiftKey ? 4 : 1) * (event.key === grow ? 1 : -1);
      onSize(clampSize(size + step, view === undefined ? size + step : extent(dock, view)));
    },
    [dock, size, onSize],
  );

  return { dragging, onPointerDown, onPointerMove, onPointerUp, onKeyDown };
}
