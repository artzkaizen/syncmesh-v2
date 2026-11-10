/**
 * The page the suite closes: starts the writing worker with the order in its query string. Closing
 * this page ends the worker with it, mid-write, which is what a user closing a tab does.
 */
import type { ChildOrder } from "./messages.js";

const query = new URLSearchParams(location.search);
const mode = query.get("mode");
const order = {
  channel: query.get("channel") ?? "",
  directory: query.get("directory") ?? "",
  name: query.get("name") ?? "",
  mode: mode === "fold" ? "fold" : "append",
} satisfies ChildOrder;
new Worker(new URL("./child.ts", import.meta.url), { type: "module" }).postMessage(order);
