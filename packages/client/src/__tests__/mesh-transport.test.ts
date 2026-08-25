import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { linkTransport, loopbackPair, type LoopbackControl } from "@syncmesh/transport";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["owner", "member"] },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const settle = async (control: LoopbackControl) => {
  for (let round = 0; round < 8; round += 1) {
    await control.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** Two meshes joined by one loopback radio; the owner holds the issuer key. */
const room = (options?: { readonly grantStaff?: boolean }) => {
  const ownerId = createIdentity(seed(7)).unwrap();
  const staffId = createIdentity(seed(160)).unwrap();
  const { a, b, control } = loopbackPair();

  const owner = createMesh({
    schema: schema(),
    identity: ownerId,
    issuer: ownerId.peerId,
    issuerKey: ownerId,
    now: () => T0,
    transports: [linkTransport("loopback:owner", () => a)],
    onGrantRequest: ({ peerId, invite }) => {
      if (invite !== "inv-42") return; // Q1: the invite token is the account proof
      owner.grants
        .issue({
          account: "acct_staff",
          device: peerId,
          role: "member",
          partitions: ["org:acme"],
          validFor: Temporal.Duration.from({ days: 1 }),
        })
        .unwrap();
    },
  });
  owner.grants
    .issue({
      account: "acct_owner",
      device: ownerId.peerId,
      role: "owner",
      partitions: ["org:acme"],
      validFor: Temporal.Duration.from({ days: 1 }),
    })
    .unwrap();

  const staff = createMesh({
    schema: schema(),
    identity: staffId,
    issuer: ownerId.peerId,
    now: () => T0,
    transports: [linkTransport("loopback:staff", () => b)],
  });
  if (options?.grantStaff !== false) {
    staff.grants
      .register(
        owner.grants
          .issue({
            account: "acct_staff",
            device: staffId.peerId,
            role: "member",
            partitions: ["org:acme"],
            validFor: Temporal.Duration.from({ days: 1 }),
          })
          .unwrap(),
      )
      .unwrap();
  }
  return { owner, staff, staffId, control };
};

describe("createMesh over transports", () => {
  test("two meshes converge; a live handle on one notifies for the other's write", async () => {
    const { owner, staff, control } = room();
    await owner.ready();
    await staff.ready();
    owner.activate("org:acme").unwrap();
    staff.activate("org:acme").unwrap();
    await settle(control);

    const list = owner.notes.list();
    let notified = 0;
    list.subscribe(() => void (notified += 1));

    (await staff.notes.insert({ id: "n1", body: "from-staff" })).unwrap();
    await settle(control);
    expect(owner.notes.byId("n1")?.body).toBe("from-staff");
    expect(notified).toBe(1);
    list.release();
    await owner.stop();
    await staff.stop();
  });

  test("flow A at the API: requestGrant with the invite lights the newcomer up", async () => {
    const { owner, staff, control } = room({ grantStaff: false });
    await Promise.all([owner.ready(), staff.ready()]);
    await settle(control);
    expect(staff.can("notes.insert")).toBe(false);

    staff.requestGrant("bad-invite");
    await settle(control);
    expect(staff.can("notes.insert")).toBe(false); // refused: the invite is the account proof

    staff.requestGrant("inv-42");
    await settle(control);
    expect(staff.can("notes.insert")).toBe(true);
    staff.activate("org:acme").unwrap();
    (await staff.notes.insert({ id: "n1", body: "onboarded" })).unwrap();
    await settle(control);
    owner.activate("org:acme").unwrap();
    expect(owner.notes.byId("n1")?.body).toBe("onboarded");
    await owner.stop();
    await staff.stop();
  });

  test("stop() closes the sessions: later writes stay local and running() flips", async () => {
    const { owner, staff, control } = room();
    await Promise.all([owner.ready(), staff.ready()]);
    owner.activate("org:acme").unwrap();
    staff.activate("org:acme").unwrap();
    await settle(control);
    expect(staff.running()).toBe(true);
    await staff.stop();
    expect(staff.running()).toBe(false);

    (await staff.notes.insert({ id: "n2", body: "offline" })).unwrap();
    await settle(control);
    expect(owner.notes.byId("n2")).toBeUndefined();
    await owner.stop();
  });
});
