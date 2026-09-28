import { hostWorker } from "../src/host-worker.js";

/**
 * A tab's dedicated worker, serving an echo instead of a mesh.
 *
 * The whole point of the seam is that this file is the only thing the RPC half changes: `serve`
 * gets a connected port and the election never learns what is said over it. An echo that names
 * itself is enough to prove *which* tab's worker a follower actually reached.
 */
const id = Math.random().toString(36).slice(2, 8);

hostWorker((port) => {
  port.onmessage = () => port.postMessage({ host: id });
});
