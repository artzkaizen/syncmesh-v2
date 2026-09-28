import type { ReactNode } from "react";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import type { SyncmeshDevtoolsProps } from "./devtools.js";

import { documentOf } from "../dom.js";
import { SyncmeshDevtools } from "./devtools.js";

/**
 * For hosts that are not a React app — a Vue page, a server-rendered template, a console paste.
 *
 * It costs one detached `<div>` and React itself, which the package already depends on; the point
 * is that the panel is one implementation whichever kind of app is being inspected, rather than a
 * React one and a second, thinner one that drifts.
 */

export interface Mounted {
  /** Takes the React root and the container away. Safe to call twice. */
  readonly unmount: () => void;
}

/** `undefined` where there is no document, which is the same answer the component gives. */
export function mount<Source>(props: SyncmeshDevtoolsProps<Source>): Mounted | undefined {
  const doc = documentOf();
  if (doc === undefined) return undefined;
  const container = doc.createElement("div");
  doc.body.append(container);
  const root = createRoot(container);
  // SAFETY: `SyncmeshDevtools` is generic, and `createElement` cannot carry the parameter through;
  // `props` is already checked against the same generic by this function's own signature.
  root.render(createElement(SyncmeshDevtools as (p: typeof props) => ReactNode, props));
  return {
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}
