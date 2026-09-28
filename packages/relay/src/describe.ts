import type { CborKey, CborValue } from "@syncmesh/wire";

import { negotiate, serialize } from "@syncmesh/wire";

import type { RelayHost } from "./host.js";

import { RELAY_PROTOCOL_VERSIONS } from "./frames.js";
import { roomOf } from "./serve.js";

/**
 * A room described over plain HTTP: what a `curl`, a health check or a person with a browser
 * learns from the path a device would dial, without opening a socket. The same facts the room's
 * own `hello` carries — its lineage, its key, the protocol it speaks — plus what a socket could
 * not ask: how many are on it, and how far its log runs.
 *
 * The body is one wire value, projected to JSON unless the caller's `Accept` asks for CBOR
 * (`negotiate`): a tool that decodes the socket's own bytes reads the same map either way.
 */
export async function describeRoom(host: RelayHost, request: Request): Promise<Response> {
  const name = host.roomFor(roomOf(request));
  const refused = await host.admits(request, name);
  if (refused !== undefined) return refused;
  const held = await host.acquire(name);
  try {
    const facts: CborValue = new Map<CborKey, CborValue>([
      ["room", name],
      ["relay", host.peerId],
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
