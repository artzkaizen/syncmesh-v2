import type { Identity } from "@syncmesh/wire";

import { createMemoryEventStore } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import type { RelayFrame } from "../frames.js";

import { webSocketDial } from "../dial.js";
import { DEFAULT_IDLE_AFTER } from "../rooms.js";
import { hostTuning, startRelay } from "../serve.js";
import { relayTransport } from "../transport.js";
import { bodyOf, peer, secureProbe, tick, until, write } from "./fixtures.js";

/** Raw client: dial, run the link handshake, join from empty cursors, and collect decoded frames — for looking at hellos and pages directly. */
const probe = async (url: string, identity: Identity) => {
  const probing = await secureProbe(webSocketDial(url), identity);
  probing.join();
  return probing;
};

/** How many events a probe has been paged, however many pages they came in. */
const paged = (probing: Awaited<ReturnType<typeof probe>>) =>
  probing.frames
    .filter((f): f is Extract<RelayFrame, { kind: "page" }> => f.kind === "page")
    .reduce((n, page) => n + page.events.length, 0);

const helloOf = (probing: Awaited<ReturnType<typeof probe>>) =>
  probing.frames.find((f): f is Extract<RelayFrame, { kind: "hello" }> => f.kind === "hello");

describe("startRelay — D09-A, the embedded host", () => {
  // every wait below is on the thing the next line checks, never on a fixed delay: a loaded
  // runner can take longer than any fixed tick, and then the assertion reads a room mid-flight
  test("two devices through a real WebSocket relay converge; a restart over the same dataDir keeps the epoch and re-sends no history", async () => {
    const dataDir = mkdtempSync(joinPath(tmpdir(), "syncmesh-relay-"));
    try {
      const relay = await startRelay(0, { dataDir, keepaliveMs: 60_000, pageSize: 2 });
      const a = peer(40, "acct_a");
      const b = peer(80, "acct_b");
      await write(a, "n1", "one");
      await write(a, "n2", "two");
      await write(a, "n3", "three");

      const ta = relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
      await ta.start(a.context);
      await ta.whenReady();
      const tb = relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
      await tb.start(b.context);
      await tb.whenReady();
      await until(() => bodyOf(b, "n3") === "three");
      expect(bodyOf(b, "n3")).toBe("three"); // a's history reached b through the relay

      await write(b, "n4", "four");
      await until(() => bodyOf(a, "n4") === "four");
      expect(bodyOf(a, "n4")).toBe("four"); // and live traffic flows the other way
      await ta.stop();
      await tb.stop();

      const before = await probe(relay.url, a.identity);
      await until(() => helloOf(before) !== undefined && paged(before) >= 4);
      const epochBefore = helloOf(before);
      expect(epochBefore).toBeDefined();
      expect(paged(before)).toBe(4); // the room's durable log holds everything
      before.close();
      await relay.stop();

      // the same file, a fresh process: same lineage, nothing re-sent to a caught-up joiner
      const revived = await startRelay(0, { dataDir, keepaliveMs: 60_000, pageSize: 2 });
      const after = await probe(revived.url, a.identity);
      await until(() => helloOf(after) !== undefined);
      expect(helloOf(after)).toBeDefined();
      expect(helloOf(after)?.epoch).toBe(epochBefore?.epoch ?? "?");
      after.close();

      const caught = relayTransport({ dial: webSocketDial(revived.url), reconnectMs: 20 });
      await caught.start(a.context); // a already holds everything: its cursors cover the log
      await caught.whenReady();
      const check = await probe(revived.url, b.identity);
      await until(() => paged(check) >= 4);
      // b's empty-cursor probe still sees all 4 — the restart lost nothing
      expect(paged(check)).toBe(4);
      check.close();
      await caught.stop();
      await revived.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("the connection cap refuses the socket past it with 503, and a close frees the seat", async () => {
    const dataDir = mkdtempSync(joinPath(tmpdir(), "syncmesh-relay-"));
    try {
      const relay = await startRelay(0, {
        dataDir,
        keepaliveMs: 60_000,
        limits: { maxConnections: 1 },
      });
      const first = new WebSocket(relay.url);
      await new Promise((resolve) => first.addEventListener("open", resolve, { once: true }));

      const refused = await fetch(relay.url.replace("ws", "http"), {
        headers: { upgrade: "websocket", connection: "upgrade" },
      });
      expect(refused.status).toBe(503);

      first.close();
      await tick(80); // the seat frees on close, so the next client is not locked out
      const admitted = new WebSocket(relay.url);
      const opened = await new Promise((resolve) => {
        admitted.addEventListener("open", () => resolve(true), { once: true });
        admitted.addEventListener("error", () => resolve(false), { once: true });
      });
      expect(opened).toBe(true);
      admitted.close();
      await relay.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("paths name rooms: two rooms on one relay do not share a log", async () => {
    const dataDir = mkdtempSync(joinPath(tmpdir(), "syncmesh-relay-"));
    try {
      const relay = await startRelay(0, { dataDir, keepaliveMs: 60_000 });
      const a = peer(40, "acct_a");
      await write(a, "n1", "one");
      const ta = relayTransport({ dial: webSocketDial(`${relay.url}/jobs`), reconnectMs: 20 });
      await ta.start(a.context);
      await ta.whenReady();
      await tick(80);
      await ta.stop();

      const other = await probe(`${relay.url}/notes`, peer(80, "acct_b").identity);
      await tick(80);
      const total = other.frames
        .filter((f): f is Extract<RelayFrame, { kind: "page" }> => f.kind === "page")
        .reduce((n, page) => n + page.events.length, 0);
      expect(total).toBe(0); // a wrote into "jobs"; "notes" is a different log
      other.close();
      await relay.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("idle eviction by default on a durable host", () => {
  const opener = async () => {
    throw new Error("not opened: only the resolved options are under test");
  };

  test("over its own dataDir a room nobody is on is evicted after DEFAULT_IDLE_AFTER", () => {
    expect(hostTuning({}, opener).idleAfter).toBe(DEFAULT_IDLE_AFTER);
    expect(DEFAULT_IDLE_AFTER.total({ unit: "minutes" })).toBe(15);
  });

  test("a caller-supplied store keeps no eviction, and a caller's own idleAfter wins", () => {
    expect(hostTuning({ store: createMemoryEventStore() }, opener).idleAfter).toBeUndefined();
    const idleAfter = Temporal.Duration.from({ minutes: 1 });
    expect(hostTuning({ idleAfter }, opener).idleAfter).toBe(idleAfter);
  });
});
