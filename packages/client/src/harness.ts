/**
 * `@syncmesh/client/internal`: what the layers under an app need of this package, and no app needs
 * at all.
 *
 * A subpath rather than a name on the main entry because the main entry is the public surface
 * (book ch. 30), and an app has one constructor: `createClient` from `@syncmesh/orpc` (D47). The
 * callers of this one are the layers underneath — that client itself, adapters that host a mesh,
 * and the harnesses that test one (chaos, bench, the engine's own suites) — which open a mesh with
 * no procedures on top. A subpath makes it hard to reach by accident, not impossible: a harness
 * may, an app should not.
 */
export { createMesh } from "./mesh.js";
