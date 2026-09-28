import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * Renders one element into a fresh root, settled once, with a `settle` that waits out a tick —
 * long enough for a fold to land and a `useSyncExternalStore` to notice. Shared by every hook
 * test here, because a second copy is a second opinion about how long "settled" is.
 */
export const mount = async (element: Parameters<Root["render"]>[0]) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(element));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
  await settle();
  return { root, container, settle };
};
