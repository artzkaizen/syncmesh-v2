import type { TelemetryEvent } from "@syncmesh/engine";
import type { RelayDial, RelayFrame, RelayTelemetry } from "@syncmesh/relay";

import { parsePartitionKey } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { decodeRelayFrame, joinCore, joinFrame, proveJoin } from "@syncmesh/relay";
import { Temporal } from "@syncmesh/temporal";
import { grantFrame } from "@syncmesh/transport";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { durableRelay } from "./hosts.js";

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ISSUER = createIdentity(seed(1)).unwrap();
const ACME = parsePartitionKey("org:acme").unwrap();
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const identity = (n: number) => createIdentity(seed(n)).unwrap();

const mintFor = (device: ReturnType<typeof identity>) =>
  issueGrant(ISSUER, {
    account: "acct_a",
    device: device.peerId,
    role: "member",
    partitions: [ACME],
    validFor: Temporal.Duration.from({ days: 1 }),
    now: T0,
  });

const collect = (dialed: RelayDial): RelayFrame[] => {
  const frames: RelayFrame[] = [];
  dialed.onFrame((bytes) => {
    const decoded = decodeRelayFrame(bytes);
    if (decoded.isOk()) frames.push(decoded.value);
  });
  return frames;
};

/** The grants a fresh joiner is handed on its catch-up — the room's cache, as a client sees it. */
const grantsPagedTo = async (object: ReturnType<typeof durableRelay>, n: number) => {
  const dialed = object.dial();
  const frames = collect(dialed);
  dialed.send(joinFrame([1], identity(n).peerId, new Map()));
  await tick(60);
  dialed.close();
  return frames.flatMap((f) => (f.kind === "page" ? f.grants : []));
};

describe("what an eviction may not lose", () => {
  test("the grants a still-connected device handed the room survive the wake", async () => {
    // left open to v1: this test scripts bare joins to get at the grant cache, and what a v2
    // join proves is the relay's own suite's business
    const object = durableRelay(new Database(":memory:"), {
      keepaliveMs: 60_000,
      versions: [1, 2],
    });

    // one long-lived device: join, then its grant — the order `relayTransport.join()` sends them
    const a = identity(40);
    const live = object.dial();
    collect(live);
    live.send(joinFrame([1], a.peerId, new Map()));
    await tick(60);
    live.send(grantFrame(mintFor(a)));
    await tick(60);
    expect(await grantsPagedTo(object, 120)).toHaveLength(1);

    // the object is evicted; `live` never noticed, so nothing will resend that grant
    object.evict();
    expect(await grantsPagedTo(object, 121)).toHaveLength(1);
    live.close();
  }, 20_000);

  test("the room's ceilings, floor and telemetry seam are the host's to set", async () => {
    const reported: TelemetryEvent[] = [];
    const object = durableRelay(new Database(":memory:"), {
      keepaliveMs: 60_000,
      // room for a signed join (138 bytes, D33) and not for the 200-byte grant below
      limits: { maxFrameBytes: 160 },
      versions: [2],
      onTelemetry: (event) => void reported.push(event),
    });

    // a floor this build cannot meet: the refusal is typed, not a mid-stream decode failure
    const old = object.dial();
    const frames = collect(old);
    old.send(joinFrame([1], identity(41).peerId, new Map()));
    await tick(60);
    expect(frames.filter((f) => f.kind === "error").map((f) => f.code)).toEqual(["version"]);

    // and a frame over the ceiling is refused before it is decoded
    const wide = object.dial();
    const seen = collect(wide);
    await tick(60);
    const challenge = seen.find((f) => f.kind === "challenge");
    if (challenge?.kind !== "challenge") throw new Error("the room sent no challenge");
    const who = identity(42);
    const core = joinCore([2], who.peerId, new Map());
    wide.send(
      joinFrame([2], who.peerId, new Map(), undefined, proveJoin(who, challenge.nonce, core)),
    );
    await tick(60);
    wide.send(grantFrame(new Uint8Array(200)));
    await tick(60);
    expect(seen.filter((f) => f.kind === "error").map((f) => f.code)).toEqual(["frame-too-large"]);

    const kinds = reported.map((event) => event.type);
    expect(kinds).toContain("relay.join" satisfies RelayTelemetry["type"]);
    wide.close();
    old.close();
  }, 20_000);
});
