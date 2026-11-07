import type { ColumnName, Row, RowKey, TableName } from "@syncmesh/kernel";
import type { WindowQuery } from "@syncmesh/window";

import { rowIs } from "@syncmesh/policy";
import { createMemoryRowSource, createWindowClient } from "@syncmesh/window";
import { describe, expect, test } from "bun:test";

import type { RelaySocket, SendOutcome } from "../sender.js";

import { serveWindows } from "../windows.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const MAIL = "mail" as TableName;
const BOX = "box" as ColumnName;
const AT = "at" as ColumnName;
const BODY = "body" as ColumnName;
const keyOf = (box: number, n: number) => `b${box}-${n}` as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const BOXES = 100;
const PER_BOX = 20;
const BODY_BYTES = 16 * 1024;

/** 100 boxes of 20 rows of 16 KB: about 32 MB once every box's window is open. */
const loaded = () => {
  const source = createMemoryRowSource();
  const rows: { key: RowKey; row: Row }[] = [];
  for (let box = 0; box < BOXES; box++) {
    const body = String.fromCharCode(97 + (box % 26)).repeat(BODY_BYTES);
    for (let n = 0; n < PER_BOX; n++)
      rows.push({
        key: keyOf(box, n),
        row: new Map<ColumnName, string | number>([
          [BOX, box],
          [AT, n],
          [BODY, body],
        ]),
      });
  }
  source.load(MAIL, rows);
  return source;
};

/** Every row is readable to these sockets; the read policy itself is the view's tests. */
const everyRow = () => true;

const boxQuery = (box: number): WindowQuery => ({
  table: MAIL,
  where: rowIs({ box }),
  order: [[AT, "desc"]],
  limit: PER_BOX,
});

/**
 * A socket whose buffer takes `room` frames and then reports "dropped" until the host drains,
 * like a WebSocket behind a slow reader. Delivered frames go to `deliver`.
 */
const slowSocket = (room: number, deliver: (frame: Uint8Array) => void) => {
  const buffered: Uint8Array[] = [];
  let closed: string | undefined;
  const socket: RelaySocket = {
    send: (frame): SendOutcome => {
      if (buffered.length >= room) return "dropped";
      buffered.push(frame);
      return "buffered";
    },
    close: (reason) => {
      closed = reason ?? "closed";
    },
  };
  return {
    socket,
    /** The far end reads everything buffered; the host is told the socket drained. */
    flush: () => {
      for (const frame of buffered.splice(0)) deliver(frame);
    },
    closed: () => closed,
  };
};

describe("serving windows on a socket (E27, D39)", () => {
  test("100 disjoint windows over 16 KB rows, a 32 MB burst, arrive whole through backpressure", () => {
    const source = loaded();
    const client = createWindowClient();
    const wire = slowSocket(8, (frame) => client.receive(frame));
    const served = serveWindows(wire.socket, { source, admits: everyRow, maxWindows: BOXES });
    client.attach((frame) => served.receive(frame));
    for (let box = 0; box < BOXES; box++) client.desire(`box-${box}`, boxQuery(box));
    // the burst outran the socket: most of it is queued, none of it dropped
    expect(served.backlog()).toBeGreaterThan(0);
    let rounds = 0;
    while (served.backlog() > 0 && rounds++ < 1000) {
      wire.flush();
      served.drain();
    }
    wire.flush();
    expect(wire.closed()).toBeUndefined();
    expect(served.view.held()).toBe(BOXES * PER_BOX);
    expect(client.held()).toBe(BOXES * PER_BOX);
    for (let box = 0; box < BOXES; box++) {
      const rows = client.rows(`box-${box}`);
      expect(rows.length).toBe(PER_BOX);
      expect(rows.every((r) => r.row.get(BOX) === box)).toBe(true);
    }
  });

  test("a client that cannot keep up is closed, never trimmed, and a new socket resnapshots it", () => {
    const source = loaded();
    const client = createWindowClient();
    const stalled = slowSocket(0, (frame) => client.receive(frame));
    const first = serveWindows(stalled.socket, {
      source,
      admits: everyRow,
      maxBacklogBytes: 4 * BODY_BYTES,
    });
    client.attach((frame) => first.receive(frame));
    client.desire("box-0", boxQuery(0));
    expect(stalled.closed()).toContain("backlog ceiling");
    first.close();
    client.detach();
    expect(client.rows("box-0")).toEqual([]);

    const fresh = slowSocket(Number.MAX_SAFE_INTEGER, (frame) => client.receive(frame));
    const second = serveWindows(fresh.socket, { source, admits: everyRow });
    client.attach((frame) => second.receive(frame));
    fresh.flush();
    expect(client.rows("box-0").length).toBe(PER_BOX);
    expect(client.status()).toBe("live");
  });

  test("frames that are not window frames are left for the socket's other reader", () => {
    const served = serveWindows(slowSocket(1, () => {}).socket, {
      source: loaded(),
      admits: everyRow,
    });
    // `ka`, the relay's keepalive, is tag 11
    expect(served.receive(Uint8Array.of(0x81, 0x0b))).toBe(false);
  });
});
