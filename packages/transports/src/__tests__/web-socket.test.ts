import { describe, expect, test } from "bun:test";

import { CannotListen, webSocket } from "../web-socket.js";

/**
 * One export, two directions (book ch. 16). What is tested here is the role decision, not the
 * relay protocol underneath it — that has its own suite in `@syncmesh/relay`.
 */
describe("webSocket — dialling and accepting are one adapter", () => {
  test("addresses to dial make a source that carries", () => {
    const source = webSocket({ id: "clinic", bootstrap: ["wss://relay.example/clinic"] });
    expect(source.name).toBe("ws:clinic");
    // a relay is the floor RFC-0012 §2 describes: always a candidate, never why a frame did not go
    expect(source.route?.()).toBeUndefined();
  });

  test("the accepting side is a server, and says so instead of being quietly offline", () => {
    // the failure this prevents: a `transports: [webSocket({ id })]` that never connects to
    // anything and reports no error, because it was waiting to be dialled by nobody
    expect(() => webSocket({ id: "clinic" })).toThrow(CannotListen);
    expect(() => webSocket({ id: "clinic" })).toThrow("createServer");
  });

  test("an empty bootstrap is the same mistake, not a different one", () => {
    expect(() => webSocket({ id: "clinic", bootstrap: [] })).toThrow(CannotListen);
  });

  test("a named source keeps its name, so `$status` can tell two rooms apart", () => {
    const source = webSocket({ id: "clinic", bootstrap: ["wss://a"], name: "primary" });
    expect(source.name).toBe("primary");
  });
});
