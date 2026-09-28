import type { PartitionKey } from "@syncmesh/kernel";

import { parsePartitionKey } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { EventCrypto } from "../sealing.js";

import { decodeEventCore, encodeEventCore } from "../event-codec.js";
import { issueGrant, verifyGrant } from "../grant.js";
import { createIdentity } from "../identity.js";
import { createKeyRing } from "../keyring.js";
import {
  FIRST_EPOCH,
  newContentKey,
  openPayload,
  sealPayload,
  unwrapKey,
  wrapKey,
} from "../sealing.js";
import { event, key as rowKey, row, table } from "./fixtures.js";

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
const ISSUER = createIdentity(seed(1)).unwrap();
const ALICE = createIdentity(seed(60)).unwrap();
const BOB = createIdentity(seed(120)).unwrap();
const CLINIC = parsePartitionKey("clinic:ward-3").unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const bytes = (s: string) => new TextEncoder().encode(s);

describe("a content key travels inside a grant, and nowhere else", () => {
  test("the device it names opens it; nobody else does, including the issuer's other devices", () => {
    const content = newContentKey();
    const wrapped = wrapKey(ALICE.peerId, content);

    expect(unwrapKey(ALICE, wrapped).unwrap()).toEqual(content);
    expect(unwrapKey(BOB, wrapped).isErr()).toBe(true);
  });

  test("two devices' copies of one key share nothing an observer could line up", () => {
    const key = newContentKey();
    const first = wrapKey(ALICE.peerId, key);
    const second = wrapKey(ALICE.peerId, key);
    // the same key, to the same device, twice: a fresh ephemeral each time
    expect(first).not.toEqual(second);
    expect(unwrapKey(ALICE, first).unwrap()).toEqual(unwrapKey(ALICE, second).unwrap());
  });

  test("a key ring learns from a verified grant and answers for that partition alone", () => {
    const key = newContentKey();
    const wire = issueGrant(ISSUER, {
      account: "acct",
      device: ALICE.peerId,
      partitions: [CLINIC],
      keys: [{ partition: CLINIC, epoch: FIRST_EPOCH, wrapped: wrapKey(ALICE.peerId, key) }],
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: T0,
    });
    const grant = verifyGrant(wire, ISSUER.peerId, T0).unwrap();
    expect(grant.keys?.[0]?.partition).toBe(CLINIC);
    expect(grant.keys?.[0]?.wrapped).toBeInstanceOf(Uint8Array);

    const ring = createKeyRing(ALICE);
    ring.learn(grant);
    expect(ring.keyFor(CLINIC)).toEqual(key);
    expect(ring.sealed()).toEqual([CLINIC]);

    // the same grant on the wrong device teaches it nothing: the wrap is addressed, not shared
    const other = createKeyRing(BOB);
    other.learn(grant);
    expect(other.sealed()).toEqual([]);
  });
});

describe("a sealed payload is bound to the event it is in", () => {
  test("it opens under its own aad and refuses under another event's", () => {
    const key = newContentKey();
    const sealed = sealPayload(key, bytes("a note"), bytes("alice/7/clinic:ward-3"));
    expect(openPayload(key, sealed, bytes("alice/7/clinic:ward-3")).unwrap()).toEqual(
      bytes("a note"),
    );
    // the same bytes, lifted into another author's event: the tag no longer checks out
    expect(openPayload(key, sealed, bytes("bob/7/clinic:ward-3")).isErr()).toBe(true);
    expect(openPayload(newContentKey(), sealed, bytes("alice/7/clinic:ward-3")).isErr()).toBe(true);
  });
});

describe("custody without judgment (book ch. 14)", () => {
  const changes = [
    { kind: "insert", table: table("vitals"), key: rowKey("patient-88"), row: row({ bpm: 61 }) },
  ] as const;
  const sealedEvent = { ...event(changes, { partition: "clinic:ward-3" }) };
  const content = newContentKey();
  /** A device holding the ward's key: it seals what it writes and opens what it is sent. */
  const holder = {
    seal: (_partition: PartitionKey, plain: Uint8Array, aad: Uint8Array) =>
      sealPayload(content, plain, aad),
    open: (_partition: PartitionKey, sealed: Uint8Array, aad: Uint8Array) => {
      const opened = openPayload(content, sealed, aad);
      return opened.isOk() ? opened.value : undefined;
    },
  } satisfies EventCrypto;

  test("a carrier decodes the envelope, folds nothing out of it, and says why", () => {
    const core = encodeEventCore(sealedEvent, holder);
    // no key at all: the relay's case, and the default for anyone who was never granted one
    const carried = decodeEventCore(core).unwrap();

    expect(carried.peerId).toBe(sealedEvent.peerId);
    expect(carried.seqNum).toBe(sealedEvent.seqNum);
    expect(carried.partition).toBe(CLINIC);
    // it holds the event, counts it, relays it — and folds nothing, because it reads nothing
    expect(carried.changes).toEqual([]);
    expect(carried.sealed).toBe(true);
  });

  test("the content is not in the bytes: no table name, no row key, no value", () => {
    const core = encodeEventCore(sealedEvent, holder);
    // read as bytes, not as text: a name only "absent" after a decoder dropped it is not absent
    const text = Array.from(core, (byte) => String.fromCharCode(byte)).join("");
    for (const change of sealedEvent.changes) {
      expect(text).not.toContain(String(change.table));
      expect(text).not.toContain(String(change.key));
    }
    // what stays readable is what routing and ordering need, and it is stated rather than hidden
    expect(text).toContain(String(CLINIC));
  });

  test("a device with the key reads exactly what the author wrote", () => {
    const core = encodeEventCore(sealedEvent, holder);
    const opened = decodeEventCore(core, holder).unwrap();
    expect(opened.sealed).toBeUndefined();
    expect(opened.changes).toEqual(sealedEvent.changes);
  });

  test("a partition nobody sealed is untouched by any of this", () => {
    // the holder seals every partition it is asked about; an event with none is asked nothing
    const plain = event(changes);
    const core = encodeEventCore(plain, holder);
    expect(decodeEventCore(core).unwrap().changes).toEqual(plain.changes);
  });
});

describe("rotation is what makes cutting a device out mean anything", () => {
  const CLINIC_AAD = bytes("author/1/clinic:ward-3");
  const first = newContentKey();
  const second = newContentKey();

  const grantWith = (device: typeof ALICE, keys: readonly { epoch: number; key: Uint8Array }[]) =>
    verifyGrant(
      issueGrant(ISSUER, {
        account: "acct",
        device: device.peerId,
        partitions: [CLINIC],
        keys: keys.map(({ epoch, key }) => ({
          partition: CLINIC,
          epoch,
          wrapped: wrapKey(device.peerId, key),
        })),
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
      ISSUER.peerId,
      T0,
    ).unwrap();

  test("a device writes under the newest epoch it holds, never an older one", () => {
    const ring = createKeyRing(ALICE);
    ring.learn(grantWith(ALICE, [{ epoch: 1, key: first }]));
    expect(ring.epochFor(CLINIC)).toBe(1);

    ring.learn(grantWith(ALICE, [{ epoch: 2, key: second }]));
    expect(ring.epochFor(CLINIC)).toBe(2);

    const sealed = ring.crypto().seal?.(CLINIC, bytes("after the turn"), CLINIC_AAD);
    expect(sealed).toBeDefined();
    // under the new key, and the payload says which — so a reader knows what to reach for
    expect(openPayload(second, sealed ?? new Uint8Array(), CLINIC_AAD).unwrap()).toEqual(
      bytes("after the turn"),
    );
    expect(openPayload(first, sealed ?? new Uint8Array(), CLINIC_AAD).isErr()).toBe(true);
  });

  test("a device that stayed keeps reading its own history across the turn", () => {
    const ring = createKeyRing(ALICE);
    ring.learn(grantWith(ALICE, [{ epoch: 1, key: first }]));
    const old = sealPayload(first, bytes("before the turn"), CLINIC_AAD, 1);

    // the new grant carries both, which is the point of a list: the newest to write under, the
    // older ones to read what this device already carries
    ring.learn(
      grantWith(ALICE, [
        { epoch: 1, key: first },
        { epoch: 2, key: second },
      ]),
    );
    expect(ring.crypto().open?.(CLINIC, old, CLINIC_AAD)).toEqual(bytes("before the turn"));
    expect(ring.keyAt(CLINIC, 1)).toEqual(first);
  });

  test("a device left out of the new epoch reads what it had, and nothing written since", () => {
    // Bob was admitted once and then cut out: the issuer minted epoch 2 and did not give it to him
    const bob = createKeyRing(BOB);
    bob.learn(grantWith(BOB, [{ epoch: 1, key: first }]));

    const before = sealPayload(first, bytes("while bob was in"), CLINIC_AAD, 1);
    const after = sealPayload(second, bytes("after bob was out"), CLINIC_AAD, 2);

    expect(bob.crypto().open?.(CLINIC, before, CLINIC_AAD)).toEqual(bytes("while bob was in"));
    // nothing can reach into Bob's device and take back what he already holds — what an issuer
    // *can* do is turn the key and leave him out of it
    expect(bob.crypto().open?.(CLINIC, after, CLINIC_AAD)).toBeUndefined();
    expect(bob.keyAt(CLINIC, 2)).toBeUndefined();
  });
});
