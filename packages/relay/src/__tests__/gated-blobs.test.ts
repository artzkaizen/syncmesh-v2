import type { PartitionKey } from "@syncmesh/kernel";
import type { BlobHomes } from "@syncmesh/storage";

import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { hashOf, memoryBlobHomes, memoryBlobStore, sqlBlobHomes } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { eventFrame, grantFrame } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import type { RelayRoomOptions } from "../room.js";

import { blobGetFrame, blobPutFrame } from "../frames.js";
import { UNGRANTED } from "../trust.js";
import {
  ACME,
  GLOBEX,
  ISSUER,
  T0,
  dialTo,
  mintFor,
  openRoom,
  peer,
  secureProbe,
  tick,
  write,
} from "./fixtures.js";

/** A grant-gated room (D40) that keeps blobs, on a clock the test owns. */
const gatedBlobRoom = (overrides: Partial<RelayRoomOptions> = {}) =>
  openRoom({
    pageSize: 100,
    now: () => T0,
    trust: { issuers: [ISSUER.peerId], wait: Temporal.Duration.from({ milliseconds: 60 }) },
    blobs: memoryBlobStore(),
    ...overrides,
  });

/** One device seated in the room under a grant naming `partitions`, speaking raw frames. */
const seated = async (
  room: Awaited<ReturnType<typeof gatedBlobRoom>>,
  n: number,
  partitions: readonly PartitionKey[],
) => {
  const device = peer(n, `acct_${n}`, 100, { partitions });
  const probe = await secureProbe(dialTo(room).dial, device.identity);
  probe.join();
  probe.send(grantFrame(mintFor(device.identity, `acct_${n}`, { partitions })));
  await tick(30);
  return {
    device,
    probe,
    put: async (bytes: Uint8Array, partition?: PartitionKey) => {
      probe.send(blobPutFrame(hashOf(bytes), bytes, partition));
      await tick(20);
    },
    /** The room's answer to a fetch: the bytes, or `missing`. */
    get: async (bytes: Uint8Array) => {
      const hash = hashOf(bytes);
      probe.send(blobGetFrame(hash));
      await tick(20);
      const answer = probe.frames
        .filter((f) => (f.kind === "blob" || f.kind === "blob-missing") && f.hash === hash)
        .at(-1);
      return answer?.kind === "blob" ? answer.bytes : "missing";
    },
  };
};

const photo = Uint8Array.from({ length: 64 }, (_, i) => i);
const payslip = Uint8Array.from({ length: 48 }, (_, i) => 255 - i);

describe("blobs in a grant-gated room (D44)", () => {
  test("a put billed to a partition the grant does not name is refused ungranted, and stores nothing", async () => {
    const room = await gatedBlobRoom();
    const acme = await seated(room, 41, [ACME]);
    await acme.put(payslip, GLOBEX);
    const refused = acme.probe.ofKind("blob-refused");
    expect(refused.map((f) => [f.code, f.partition])).toEqual([[UNGRANTED, GLOBEX]]);
    expect(acme.probe.ofKind("blob-stored")).toEqual([]);
    // the globex member is not served it either: it was never stored
    const globex = await seated(room, 42, [GLOBEX]);
    expect(await globex.get(payslip)).toBe("missing");
    room.close();
  });

  test("a fetch is served to a grant naming a partition the bytes were put into, and to nobody else", async () => {
    const room = await gatedBlobRoom();
    const owner = await seated(room, 41, [GLOBEX]);
    await owner.put(payslip, GLOBEX);
    expect(owner.probe.ofKind("blob-stored").length).toBe(1);
    expect(await owner.get(payslip)).toEqual(payslip);

    const colleague = await seated(room, 42, [GLOBEX]);
    expect(await colleague.get(payslip)).toEqual(payslip);
    const outsider = await seated(room, 43, [ACME]);
    // the same answer as for bytes the room never held: a refusal must not confirm the hash
    expect(await outsider.get(payslip)).toBe("missing");
    expect(await outsider.get(Uint8Array.of(9, 9, 9))).toBe("missing");
    room.close();
  });

  test("a leaked hash written into a row of the asker's own partition authorises nothing", async () => {
    const room = await gatedBlobRoom();
    const owner = await seated(room, 41, [GLOBEX]);
    await owner.put(payslip, GLOBEX);

    // the attacker knows the hash and names it in a row it may write — the reference the sweep
    // reads — and asks again: a reference is not provenance
    const attacker = await seated(room, 43, [ACME]);
    attacker.probe.send(eventFrame(await write(attacker.device, "bait", hashOf(payslip), ACME)));
    await tick(30);
    expect(await attacker.get(payslip)).toBe("missing");
    // nor can it claim the bytes by putting them under its own partition without holding them:
    // a put carries the bytes, and junk under the hash is refused before anything is recorded
    attacker.probe.send(blobPutFrame(hashOf(payslip), Uint8Array.of(1), ACME));
    await tick(20);
    expect(await attacker.get(payslip)).toBe("missing");
    room.close();
  });

  test("bytes put with no partition are readable by every seated device, as an unpinned row is", async () => {
    const room = await gatedBlobRoom();
    const a = await seated(room, 41, [ACME]);
    await a.put(photo);
    expect(a.probe.ofKind("blob-stored").length).toBe(1);
    const b = await seated(room, 42, [GLOBEX]);
    expect(await b.get(photo)).toEqual(photo);
    room.close();
  });

  test("a second put of held bytes into another partition opens them to that partition too", async () => {
    const room = await gatedBlobRoom();
    const a = await seated(room, 41, [ACME]);
    await a.put(photo, ACME);
    const b = await seated(room, 42, [GLOBEX]);
    expect(await b.get(photo)).toBe("missing");
    // a globex member who also holds the bytes shares them with globex by putting them there
    await b.put(photo, GLOBEX);
    expect(b.probe.ofKind("blob-stored").length).toBe(1);
    expect(await b.get(photo)).toEqual(photo);
    room.close();
  });

  test("where a blob may be read survives the room reopening over the same database", async () => {
    const driver = bunSqliteDriver(":memory:");
    const homes: BlobHomes = (await sqlBlobHomes(driver)).unwrap();
    const blobs = memoryBlobStore();
    const first = await gatedBlobRoom({ blobs, blobHomes: homes });
    const owner = await seated(first, 41, [GLOBEX]);
    await owner.put(payslip, GLOBEX);
    first.close();

    const reopened = await gatedBlobRoom({
      blobs,
      blobHomes: (await sqlBlobHomes(driver)).unwrap(),
    });
    const colleague = await seated(reopened, 42, [GLOBEX]);
    expect(await colleague.get(payslip)).toEqual(payslip);
    const outsider = await seated(reopened, 43, [ACME]);
    expect(await outsider.get(payslip)).toBe("missing");
    reopened.close();
  });

  test("an open room checks neither half", async () => {
    const room = await openRoom({ pageSize: 100, now: () => T0, blobs: memoryBlobStore() });
    const a = peer(41, "acct_a", 100, { partitions: [ACME] });
    const probe = await secureProbe(dialTo(room).dial, a.identity);
    probe.join();
    await tick(20);
    probe.send(blobPutFrame(hashOf(payslip), payslip, GLOBEX));
    await tick(20);
    expect(probe.ofKind("blob-stored").length).toBe(1);
    probe.send(blobGetFrame(hashOf(payslip)));
    await tick(20);
    expect(probe.ofKind("blob").map((f) => f.bytes)).toEqual([payslip]);
    room.close();
  });

  test("homes kept in memory answer the same as durable ones within a run", async () => {
    const room = await gatedBlobRoom({ blobHomes: memoryBlobHomes() });
    const owner = await seated(room, 41, [GLOBEX]);
    await owner.put(payslip, GLOBEX);
    const outsider = await seated(room, 43, [ACME]);
    expect(await outsider.get(payslip)).toBe("missing");
    expect(await owner.get(payslip)).toEqual(payslip);
    room.close();
  });
});
