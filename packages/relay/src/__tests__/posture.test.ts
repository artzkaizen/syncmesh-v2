import { createMemoryEventStore } from "@syncmesh/engine";
import { describe, expect, test } from "bun:test";

import type { RelayPosture } from "../posture.js";

import { webSocketDial } from "../dial.js";
import { createRoomAccess } from "../posture.js";
import { startRelay } from "../serve.js";
import { relayTransport } from "../transport.js";
import { bodyOf, peer, tick, until, write } from "./fixtures.js";

/** A relay on a memory log, so a posture test never touches the disk. */
const serve = (posture?: RelayPosture) =>
  startRelay(0, {
    keepaliveMs: 60_000,
    store: createMemoryEventStore(),
    epoch: "epoch-1",
    ...(posture !== undefined && { posture }),
  });

/** A plain GET: 426 means the posture let it through and only the missing upgrade stopped it. */
const knock = (url: string, headers: Record<string, string> = {}) =>
  fetch(url.replace("ws://", "http://"), { headers });

describe("origins", () => {
  test("no allowlist admits every origin, stated or not", async () => {
    const relay = await serve();
    try {
      expect((await knock(relay.url)).status).toBe(426);
      expect((await knock(relay.url, { origin: "https://anywhere.example" })).status).toBe(426);
    } finally {
      await relay.stop();
    }
  });

  test("a stated origin off the list is refused before any socket exists", async () => {
    const relay = await serve({ allowedOrigins: ["https://app.example"] });
    try {
      expect((await knock(relay.url, { origin: "https://app.example" })).status).toBe(426);
      expect((await knock(relay.url, { origin: "https://evil.example" })).status).toBe(403);
      // a client that states no origin is still admitted: `Origin` is a browser's own declaration,
      // and refusing its absence turns away every server-side client while stopping nobody
      expect((await knock(relay.url)).status).toBe(426);
    } finally {
      await relay.stop();
    }
  });
});

describe("announce, separate from access", () => {
  test("announce on (the default) invents a room for any path", async () => {
    const relay = await serve();
    try {
      expect((await knock(`${relay.url}/whatever`)).status).toBe(426);
    } finally {
      await relay.stop();
    }
  });

  test("announce off serves only the rooms it was told about", async () => {
    const relay = await serve({ announce: false, rooms: ["jobs", "main"] });
    try {
      expect((await knock(`${relay.url}/jobs`)).status).toBe(426);
      expect((await knock(relay.url)).status).toBe(426); // `/` names `main`, which is listed
      expect((await knock(`${relay.url}/notes`)).status).toBe(404);
    } finally {
      await relay.stop();
    }
  });

  test("a rooms list with announce left on restricts nothing, deliberately", async () => {
    const relay = await serve({ rooms: ["jobs"] });
    try {
      expect((await knock(`${relay.url}/notes`)).status).toBe(426);
    } finally {
      await relay.stop();
    }
  });
});

describe("access — verifyJoin", () => {
  test("it sees the room, and its refusal is a 403 before the upgrade", async () => {
    const asked: string[] = [];
    const relay = await serve({
      verifyJoin: (request, room) => {
        asked.push(room);
        return new URL(request.url).searchParams.get("ticket") === "ok";
      },
    });
    try {
      expect((await knock(`${relay.url}/jobs?ticket=ok`)).status).toBe(426);
      expect((await knock(`${relay.url}/jobs?ticket=no`)).status).toBe(403);
      expect(asked).toEqual(["jobs", "jobs"]);
    } finally {
      await relay.stop();
    }
  });

  test("an async verifyJoin still upgrades, and the room works end to end", async () => {
    const relay = await serve({ verifyJoin: () => Promise.resolve(true) });
    try {
      const a = peer(40, "acct_a");
      const b = peer(80, "acct_b");
      await write(a, "n1", "one");
      const ta = relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
      const tb = relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
      await ta.start(a.context);
      await tb.start(b.context);
      expect(await until(() => bodyOf(b, "n1") === "one")).toBe(true);
      await ta.stop();
      await tb.stop();
      await tick();
    } finally {
      await relay.stop();
    }
  }, 20_000);
});

describe("the posture on its own", () => {
  const request = new Request("http://relay.example/jobs");

  test("the defaults are the open relay this package shipped with", async () => {
    const access = createRoomAccess();
    expect(access.admitsOrigin(null)).toBe(true);
    expect(access.admitsOrigin("https://anywhere.example")).toBe(true);
    expect(access.announces("anything")).toBe(true);
    expect(await access.admitsJoin(request, "jobs")).toBe(true);
  });

  test("announce off with no rooms serves nothing at all — a stated, checkable posture", () => {
    const access = createRoomAccess({ announce: false });
    expect(access.announces("main")).toBe(false);
  });
});
