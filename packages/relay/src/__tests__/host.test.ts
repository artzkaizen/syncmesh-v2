import { describe, expect, test } from "bun:test";

import { dialRequest, fakeSocket, memoryHost, tick } from "./fixtures.js";

describe("the room's socket cap (gap audit №5)", () => {
  test("a full room refuses the next upgrade with 503 while another room still admits", async () => {
    const host = memoryHost({ limits: { maxRoomConnections: 2 } });
    const first = host.accept(fakeSocket().socket, "jobs");
    host.accept(fakeSocket().socket, "jobs");

    expect((await host.gate(dialRequest("jobs"), "jobs"))?.status).toBe(503);
    expect(await host.gate(dialRequest("notes"), "notes")).toBeUndefined();

    first.closed(); // the seat frees on close, once the room it was waiting on hands it back
    await tick();
    expect(await host.gate(dialRequest("jobs"), "jobs")).toBeUndefined();
    await host.close();
  });
});

describe("the open-room cap", () => {
  test("a name that would open a room past the cap gets 503, and an open room still admits", async () => {
    const host = memoryHost({ limits: { maxRooms: 1 } });
    host.accept(fakeSocket().socket, "jobs");

    expect((await host.gate(dialRequest("notes"), "notes"))?.status).toBe(503);
    expect(await host.gate(dialRequest("jobs"), "jobs")).toBeUndefined();
    await host.close();
  });
});
