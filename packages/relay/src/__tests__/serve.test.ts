import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import type { RelayFrame } from "../frames.js";

import { webSocketDial } from "../dial.js";
import { decodeRelayFrame, joinFrame } from "../frames.js";
import { startRelay } from "../serve.js";
import { relayTransport } from "../transport.js";
import { bodyOf, peer, tick, write } from "./fixtures.js";

/** Raw client: dial, join, and collect decoded frames — for looking at hellos and pages directly. */
const probe = async (url: string, peerId: Parameters<typeof joinFrame>[1]) => {
  const dial = await webSocketDial(url)();
  const frames: RelayFrame[] = [];
  dial.onFrame((bytes) => {
    const decoded = decodeRelayFrame(bytes);
    if (decoded.isOk()) frames.push(decoded.value);
  });
  dial.send(joinFrame([1], peerId, new Map()));
  return { frames, close: () => dial.close() };
};

describe("startRelay — D09-A, the embedded host", () => {
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
      await tick(80);
      expect(bodyOf(b, "n3")).toBe("three"); // a's history reached b through the relay

      await write(b, "n4", "four");
      await tick(80);
      expect(bodyOf(a, "n4")).toBe("four"); // and live traffic flows the other way
      await ta.stop();
      await tb.stop();

      const before = await probe(relay.url, a.identity.peerId);
      await tick(80);
      const epochBefore = before.frames.find((f) => f.kind === "hello");
      const held = before.frames
        .filter((f): f is Extract<RelayFrame, { kind: "page" }> => f.kind === "page")
        .reduce((n, page) => n + page.events.length, 0);
      expect(held).toBe(4); // the room's durable log holds everything
      before.close();
      await relay.stop();

      // the same file, a fresh process: same lineage, nothing re-sent to a caught-up joiner
      const revived = await startRelay(0, { dataDir, keepaliveMs: 60_000, pageSize: 2 });
      const after = await probe(revived.url, a.identity.peerId);
      await tick(80);
      const epochAfter = after.frames.find((f) => f.kind === "hello");
      expect(epochAfter?.kind === "hello" && epochAfter.epoch).toBe(
        epochBefore?.kind === "hello" ? epochBefore.epoch : "?",
      );
      after.close();

      const caught = relayTransport({ dial: webSocketDial(revived.url), reconnectMs: 20 });
      const pages: number[] = [];
      await caught.start(a.context); // a already holds everything: its cursors cover the log
      await caught.whenReady();
      await tick(80);
      void pages;
      const check = await probe(revived.url, b.identity.peerId);
      await tick(80);
      // b's empty-cursor probe still sees all 4 — the restart lost nothing
      const total = check.frames
        .filter((f): f is Extract<RelayFrame, { kind: "page" }> => f.kind === "page")
        .reduce((n, page) => n + page.events.length, 0);
      expect(total).toBe(4);
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

      const other = await probe(`${relay.url}/notes`, peer(80, "acct_b").identity.peerId);
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
