import type { CborKey, CborValue } from "@syncmesh/wire";

import { negotiate, serialize } from "@syncmesh/wire";

import type { RelayHost } from "./host.js";

import { RELAY_PROTOCOL_VERSIONS } from "./frames.js";

/** The room a request's path names; `/` is `main`, and a leading slash is not part of the name. */
export const requestRoom = (request: Request): string => {
  const path = new URL(request.url).pathname.replace(/^\/+/, "");
  return path === "" ? "main" : path;
};

/**
 * A room described over plain HTTP: what a `curl`, a health check or a person with a browser
 * learns from the path a device would dial, without opening a socket. The same facts the room's
 * own `hello` carries — its lineage, its key, the protocol it speaks — plus what a socket could
 * not ask: how many are on it, and how far its log runs.
 *
 * The body is one wire value, projected to JSON unless the caller's `Accept` asks for CBOR
 * (`negotiate`): a tool that decodes the socket's own bytes reads the same map either way.
 *
 * `name` is the room the path names unless the host says otherwise — a host where the platform
 * already routed the request to the room (a Durable Object, an actor) passes the room's own name,
 * since the path there is routing.
 */
export async function describeRoom(
  host: RelayHost,
  request: Request,
  name = requestRoom(request),
): Promise<Response> {
  const refused = await host.admits(request, name);
  if (refused !== undefined) return refused;
  const held = await host.acquire(name);
  try {
    const facts: CborValue = new Map<CborKey, CborValue>([
      ["room", name],
      // the room's own key, which is the host's unless its store kept one beside the log (D36)
      ["relay", held.room.peerId],
      ["versions", [...RELAY_PROTOCOL_VERSIONS]],
      ["epoch", held.room.epoch],
      ["offset", held.room.offset()],
      ["clients", held.room.clients()],
    ]);
    const media = negotiate(request.headers.get("accept"));
    // SAFETY: the body is a fresh array `serialize` just allocated over a plain `ArrayBuffer`;
    // the DOM types only doubt it because a bare `Uint8Array` could be over a shared one
    return new Response(serialize(facts, media) as Uint8Array<ArrayBuffer>, {
      headers: { "content-type": media, vary: "accept" },
    });
  } finally {
    held.release();
  }
}
