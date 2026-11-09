import { parsePeerId } from "@syncmesh/kernel";
import { encodeCbor } from "@syncmesh/wire";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { DurableRelayContext } from "../host.js";

import { relayDurableHost } from "../host.js";
import { decodeResume, encodeResume, linkSealer } from "../resume.js";
import { durableSqlOver } from "./durable-sql.js";

/**
 * A socket's resume script sits in its attachment, which the platform keeps at rest; the link's
 * secret and session keys in it are sealed under the object's attachment key (N26).
 */

const PEER = parsePeerId("b".repeat(64)).unwrap();
const SEAL = new Uint8Array(32).fill(1);
const OPEN = new Uint8Array(32).fill(2);
const SECRET = new Uint8Array(32).fill(3);
const sealer = linkSealer(new Uint8Array(32).fill(7));

/** Whether `needle` appears anywhere in `bytes`. */
const holds = (bytes: Uint8Array, needle: Uint8Array) =>
  bytes.some((_, at) => needle.every((byte, i) => bytes[at + i] === byte));

describe("a socket's link secrets at rest (N26)", () => {
  test("an attachment carries no bare session key or offered secret, and opens back whole", () => {
    const session = { peer: PEER, keys: { seal: SEAL, open: OPEN } };
    const bytes = encodeResume({ session, grants: [] }, sealer);
    if (bytes === undefined) throw new Error("the script fits");
    expect(holds(bytes, SEAL)).toBe(false);
    expect(holds(bytes, OPEN)).toBe(false);
    expect(decodeResume(bytes, sealer).session).toEqual(session);

    const offer = { secret: SECRET, hello: new Uint8Array([9, 9]) };
    const offered = encodeResume({ offer, grants: [] }, sealer);
    if (offered === undefined) throw new Error("the script fits");
    expect(holds(offered, SECRET)).toBe(false);
    expect(decodeResume(offered, sealer).offer).toEqual(offer);
  });

  test("under another key the secrets do not open: the socket wakes without them", () => {
    const session = { peer: PEER, keys: { seal: SEAL, open: OPEN } };
    const bytes = encodeResume({ session, grants: [] }, sealer);
    if (bytes === undefined) throw new Error("the script fits");
    expect(decodeResume(bytes, linkSealer(new Uint8Array(32).fill(8))).session).toBeUndefined();
  });

  test("a script an earlier build wrote with bare keys still resumes", () => {
    const peer = Uint8Array.from(Buffer.from(PEER, "hex"));
    const legacy = encodeCbor([[null, null, null, SEAL, OPEN, peer]]);
    expect(decodeResume(legacy, sealer).session).toEqual({
      peer: PEER,
      keys: { seal: SEAL, open: OPEN },
    });
  });

  test("an object given no vault is a definition error", () => {
    const ctx: DurableRelayContext = {
      storage: { sql: durableSqlOver(new Database(":memory:")) },
      acceptWebSocket: () => undefined,
      getWebSockets: () => [],
    };
    expect(() => relayDurableHost(ctx, { posture: { open: true } })).toThrow("pass `vault`");
  });
});
