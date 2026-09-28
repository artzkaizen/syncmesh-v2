import type { TelemetryEvent } from "@syncmesh/engine";

import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { DEFAULT_MAX_BLOB_BYTES, DURABLE_RETENTION } from "../retention.js";
import { openRoom } from "./fixtures.js";

/**
 * An unconfigured room used to grow forever in both halves (gap audit №8). One of the two now has
 * a default and the other has a name, and the difference between them is the whole point: a blob
 * this room drops can be put back by anyone still holding it, and an event it trims is gone from
 * this hop for good.
 */
describe("what a room keeps when nobody said", () => {
  test("the blob half has a ceiling, because a dropped blob is a miss and not a loss", async () => {
    const seen: TelemetryEvent[] = [];
    const room = await openRoom({ onTelemetry: (event) => void seen.push(event) });
    const said = seen.find((event) => event.type === "relay.retention.unbounded");
    expect(said?.sizes).toEqual({ blobBytes: DEFAULT_MAX_BLOB_BYTES });
    room.close();
  });

  test("the log half keeps everything, and the room says so once rather than growing quietly", async () => {
    const seen: TelemetryEvent[] = [];
    const room = await openRoom({ onTelemetry: (event) => void seen.push(event) });
    expect(seen.filter((event) => event.type === "relay.retention.unbounded")).toHaveLength(1);
    room.close();
  });

  test("a room that trims says nothing: the decision was made, and that is the report", async () => {
    const seen: TelemetryEvent[] = [];
    const room = await openRoom({
      retention: DURABLE_RETENTION,
      onTelemetry: (event) => void seen.push(event),
    });
    expect(seen.filter((event) => event.type === "relay.retention.unbounded")).toEqual([]);
    room.close();
  });

  test("the production preset is thirty days and a gibibyte, named rather than assembled", () => {
    expect(DURABLE_RETENTION.keepEventsFor.total({ unit: "days" })).toBe(30);
    expect(DURABLE_RETENTION.maxBlobBytes).toBe(DEFAULT_MAX_BLOB_BYTES);
    // and it is a real duration, not a number anyone has to interpret
    expect(DURABLE_RETENTION.keepEventsFor).toBeInstanceOf(Temporal.Duration);
  });
});
