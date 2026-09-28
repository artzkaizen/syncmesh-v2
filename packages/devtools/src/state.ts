/**
 * What the panel remembers about itself, and the arithmetic for changing it.
 *
 * Plain values and pure functions, kept out of the React tree on purpose: a drag that resizes the
 * panel is the one interaction here that runs at pointer rate, and clamping a number is easier to
 * be sure about — and to test — when it is not also a re-render.
 */

/** Which edge the panel is attached to. Two, because a devtool that floats is a devtool you move. */
export type Dock = "bottom" | "right";

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] satisfies Corner[];

export interface PanelState {
  readonly open: boolean;
  readonly dock: Dock;
  /**
   * Height when docked bottom, width when docked right. One number and not two, because a dock
   * change that also changed the size would land the user in a panel they did not shape.
   */
  readonly size: number;
  /** Where the bubble sits while the panel is closed. */
  readonly corner: Corner;
  /** The tab that was open, or `undefined` for "whatever is first". */
  readonly tab: string | undefined;
}

export const DEFAULT_PANEL_STATE = {
  open: false,
  dock: "bottom",
  size: 380,
  corner: "bottom-right",
  tab: undefined,
} satisfies PanelState;

/** Below this the tab bar wraps and the body is two rows tall, which is not a panel, it is a hint. */
export const MIN_SIZE = 180;

/** The host page keeps a strip of itself. A devtool that can cover the app is a devtool you close to work. */
export const MAX_SIZE_RATIO = 0.9;

/**
 * The size the panel will actually take, given how much room there is.
 *
 * Clamped on read as well as on drag: the viewport that produced a remembered 900px may have been
 * a second monitor, and the laptop it is reopened on should not get a panel taller than itself.
 */
export function clampSize(size: number, viewport: number): number {
  const ceiling = Math.max(MIN_SIZE, Math.floor(viewport * MAX_SIZE_RATIO));
  return Math.min(ceiling, Math.max(MIN_SIZE, Math.round(size)));
}

/**
 * Where the drag handle has moved to, expressed as a size.
 *
 * The handle is on the edge facing the page, so a bottom-docked panel grows as the pointer goes up
 * and a right-docked one grows as it goes left. Both are the viewport extent minus the pointer
 * along the docked axis, which is why there is one function here and not two: the caller picks the
 * axis by choosing which coordinate to pass.
 */
export function sizeFromPointer(pointer: number, viewport: number): number {
  return clampSize(viewport - pointer, viewport);
}
