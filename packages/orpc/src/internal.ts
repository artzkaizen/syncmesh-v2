/**
 * What one constructor needs of another package, and no app needs at all.
 *
 * A subpath rather than a name on the main entry, because the main entry **is** the public surface
 * (book ch. 30): if it is not on that chapter's list, it is not public. `meshApi` was on the main
 * entry once and the cost was not theoretical — a follower tab assembled by hand the surface the
 * leader is handed, so an app had two ways to get a client and only one of them was specified.
 *
 * The two legitimate callers are the two constructors that turn a mesh into a client:
 * `createClient` in this package, and `connectMesh` in `@syncmesh/browser`.
 */
export { meshApi } from "./api.js";
