import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { seed } from "@syncmesh/kernel/test-fixtures";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { sqlEventStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import {
  cursorsFrame,
  decodeFrame,
  linkTransport,
  loopbackPair,
  snapManifestFrame,
} from "@syncmesh/transport";
import { checkpointHash, createIdentity, issueCheckpoint } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

const org = partition("org", { roles: ladder("member") });
const schema = () =>
  syncSchema({
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: org,
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const issuer = createIdentity(seed(7)).unwrap();
const device = createIdentity(seed(160)).unwrap();
const far = createIdentity(seed(90)).unwrap();
const author = createIdentity(seed(120)).unwrap().peerId;

/**
 * D46 through `createMesh`: the floor a peer sends on its cursors frame reaches the mesh's
 * `$recovery`, the status says the device is blocked, and accepting the issue asks again. The
 * far side is raw frames, so what the device sends is what the test reads.
 */
describe("$recovery below a peer's compaction floor (D46)", () => {
  test("an unvouched answer raises the issue, blocks the status, and accepting it asks again", async () => {
    const { a, b, control } = loopbackPair();
    const mesh = (
      await createMesh({
        storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
        schema: schema(),
        identity: device,
        trust: { issuer: issuer.peerId },
        now: () => T0,
        transports: [linkTransport("loopback", () => b)],
      })
    ).unwrap();
    const asked: string[] = [];
    a.onFrame((bytes) => {
      const frame = decodeFrame(bytes);
      if (frame.isOk() && frame.value.kind === "snap-req") asked.push(frame.value.kind);
    });
    const settle = async () => {
      for (let round = 0; round < 8; round += 1) {
        await control.flush();
        await mesh.flush();
      }
    };
    await mesh.ready();
    await settle();
    // the device holds nothing, so its cold join asked first: answered with nothing at all
    expect(asked).toHaveLength(1);
    a.send(snapManifestFrame("far:0", 0, 0, new Map()));

    // the far side holds the author up to 9 and compacted it below 5; this device holds none
    // SAFETY: test fixture sequence numbers
    const at = (n: number) => n as SeqNum;
    const floor = new Map<PeerId, SeqNum>([[author, at(5)]]);
    a.send(cursorsFrame(far.peerId, new Map([[author, at(9)]]), new Map(), floor));
    await settle();
    expect(asked).toHaveLength(2);

    // a status subscriber is told, not left polling: the health it reads next is blocked
    const heard: string[] = [];
    const offStatus = mesh.status.subscribe(() => heard.push(mesh.status.get().health));
    const offFloor = mesh.recovery.onBelowFloor(() => heard.push("below-floor"));

    // it answers with no rows and no certificate: nothing vouched, so nothing is adopted
    a.send(snapManifestFrame("far:1", 0, 0, new Map([[author, at(9)]])));
    await settle();
    expect(heard).toEqual(["blocked-recovery", "below-floor"]);
    expect(mesh.engine.coverage().synced.get(author)).toBeUndefined();
    expect(mesh.recovery.belowFloor()).toEqual([
      { peer: far.peerId, floor, reason: "unvouched", message: expect.any(String) },
    ]);
    expect(mesh.status.get().health).toBe("blocked-recovery");

    // the operator takes it anyway (an override a trusted mesh allows too): the request goes out
    // on the open session, the issue stays until it is answered, and the answer adopts the floor
    // and no further
    expect(mesh.recovery.acceptState(far.peerId)).toBe("requested");
    await settle();
    expect(asked).toHaveLength(3);
    expect(mesh.recovery.belowFloor()).toHaveLength(1);
    a.send(snapManifestFrame("far:2", 0, 0, new Map([[author, at(9)]])));
    await settle();
    expect(Number(mesh.engine.coverage().synced.get(author))).toBe(5);
    expect(mesh.recovery.belowFloor()).toEqual([]);
    expect(mesh.status.get().health).not.toBe("blocked-recovery");
    // and told again when the issue went
    expect(heard.slice(2, 4)).toEqual([
      expect.not.stringMatching("blocked-recovery"),
      "below-floor",
    ]);
    offStatus();
    offFloor();
    await mesh.stop();
  });

  test("a state rebuilt without what a snapshot install brought raises the issue at open (gaps U33)", async () => {
    // SAFETY: test fixture sequence numbers
    const at = (n: number) => n as SeqNum;
    const driver = bunSqliteDriver(":memory:");
    const open = async () =>
      (
        await createMesh({
          storage: sqlite({ driver }),
          schema: schema(),
          identity: device,
          now: () => T0,
          transports: [],
        })
      ).unwrap();
    const first = await open();
    await first.ready();
    expect(first.recovery.belowFloor()).toEqual([]);
    await first.stop();
    // the log says an install brought the author through 5; the state that held those rows is gone
    const log = (await sqlEventStore(driver)).unwrap();
    (await log.recordInstalled(new Map([[author, at(5)]]))).unwrap();

    const mesh = await open();
    await mesh.ready();
    expect(mesh.recovery.belowFloor()).toEqual([
      { floor: new Map([[author, at(5)]]), reason: "rebuilt", message: expect.any(String) },
    ]);
    expect(mesh.status.get().health).toBe("blocked-recovery");
    expect(mesh.recovery.acceptState(far.peerId)).toBe("nothing-to-accept");
    await mesh.stop();
  });

  /**
   * `createMesh` handed `trust` and `certificate` to the transports' context, which dropped both,
   * so no snapshot a mesh took was ever vouched for and a vouched floor could never be adopted.
   */
  test("a mesh with an issuer believes a certificate it signed", async () => {
    const { a, b, control } = loopbackPair();
    const mesh = (
      await createMesh({
        storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
        schema: schema(),
        identity: device,
        trust: { issuer: issuer.peerId },
        now: () => T0,
        transports: [linkTransport("loopback", () => b)],
      })
    ).unwrap();
    const certificate = issueCheckpoint(issuer, {
      stateHash: checkpointHash([]),
      coverage: new Map(),
      now: T0,
    });
    // every request is answered with no rows and the issuer's certificate over exactly that
    let answered = 0;
    a.onFrame((bytes) => {
      const frame = decodeFrame(bytes);
      if (frame.isErr() || frame.value.kind !== "snap-req") return;
      answered += 1;
      queueMicrotask(() =>
        a.send(snapManifestFrame(`far:${answered}`, 0, 0, new Map(), undefined, certificate)),
      );
    });
    await mesh.ready();
    const rebuilt = mesh.recovery.rebuild({ timeoutMs: 2_000 });
    for (let round = 0; round < 8; round += 1) {
      await control.flush();
      await mesh.flush();
    }
    expect((await rebuilt).unwrap()).toEqual({ rows: 0, vouched: true, pending: 0 });
    await mesh.stop();
  });
});
