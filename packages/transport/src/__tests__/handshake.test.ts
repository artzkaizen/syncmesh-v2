import { seed } from "@syncmesh/kernel/test-fixtures";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import {
  HELLO_BYTES,
  ephemeralSecret,
  readHello,
  seal,
  sealNonce,
  sessionKeys,
  unseal,
  writeHello,
} from "../handshake.js";

const ALICE = createIdentity(seed(1)).unwrap();
const BOB = createIdentity(seed(2)).unwrap();
const MALLORY = createIdentity(seed(3)).unwrap();

/** Both ends of one exchange: their secrets, their hellos, and the keys they each derive. */
const exchange = (a = ALICE, b = BOB) => {
  const secrets = { a: ephemeralSecret(), b: ephemeralSecret() };
  const hellos = { a: writeHello(a, secrets.a), b: writeHello(b, secrets.b) };
  return {
    secrets,
    hellos,
    keys: {
      a: sessionKeys(secrets.a, hellos.a, hellos.b).unwrap(),
      b: sessionKeys(secrets.b, hellos.b, hellos.a).unwrap(),
    },
  };
};

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("the hello two devices open with", () => {
  test("carries the peer id it is signed by, so the link knows who it is talking to", () => {
    const hello = writeHello(ALICE, ephemeralSecret());
    const read = readHello(hello.frame).unwrap();
    expect(read.peerId).toBe(ALICE.peerId);
    expect(hello.frame).toHaveLength(HELLO_BYTES);
  });

  test("a hello nobody signed is not one — an unsigned key exchange has a man in the middle", () => {
    const hello = writeHello(ALICE, ephemeralSecret());
    // swap in Mallory's ephemeral key and keep Alice's signature: this is the whole attack
    const forged = Uint8Array.from(hello.frame);
    forged.set(writeHello(MALLORY, ephemeralSecret()).ephemeral, 33);
    expect(readHello(forged).isErr()).toBe(true);
  });

  test("a truncated or foreign frame reads as nothing rather than as a peer", () => {
    expect(readHello(new Uint8Array(HELLO_BYTES)).isErr()).toBe(true);
    expect(readHello(bytes("hello there")).isErr()).toBe(true);
    expect(readHello(new Uint8Array(0)).isErr()).toBe(true);
  });
});

describe("the session key two devices agree on", () => {
  test("is the same on both ends, and crossed — each seals with what the other opens", () => {
    const { keys } = exchange();
    expect(keys.a.seal).toEqual(keys.b.open);
    expect(keys.b.seal).toEqual(keys.a.open);
    // and the two directions are not the same key, so neither shares a nonce space with the other
    expect(keys.a.seal).not.toEqual(keys.a.open);
  });

  test("is fresh per link, so a device seized tomorrow does not read what it heard today", () => {
    const first = exchange();
    const second = exchange();
    expect(first.keys.a.seal).not.toEqual(second.keys.a.seal);
  });

  test("differs on the two ends when anyone swapped a frame in the middle", () => {
    // Mallory relays, substituting her own hello towards Bob while Alice sees the real one
    const { secrets, hellos } = exchange();
    const mallory = { secret: ephemeralSecret() };
    const swapped = writeHello(MALLORY, mallory.secret);
    const bobSees = sessionKeys(secrets.b, hellos.b, swapped).unwrap();
    const aliceSees = sessionKeys(secrets.a, hellos.a, hellos.b).unwrap();
    // the transcript is the salt: neither end's key survives the substitution
    expect(bobSees.open).not.toEqual(aliceSees.seal);
    expect(unseal(bobSees.open, seal(aliceSees.seal, bytes("hi"), sealNonce())).isErr()).toBe(true);
  });

  test("refuses our own hello reflected back, which would be a link to ourselves", () => {
    const secret = ephemeralSecret();
    const self = writeHello(ALICE, secret);
    expect(sessionKeys(secret, self, self).isErr()).toBe(true);
  });
});

describe("a sealed frame", () => {
  test("opens on the far end and nowhere else", () => {
    const { keys } = exchange();
    const sealed = seal(keys.a.seal, bytes("the quick brown fox"), sealNonce());
    expect(text(unseal(keys.b.open, sealed).unwrap())).toBe("the quick brown fox");
    // Mallory has the frame off the air and no key; this is what a sniffer gets
    expect(unseal(exchange().keys.a.open, sealed).isErr()).toBe(true);
  });

  test("shows a sniffer nothing of what it carries", () => {
    const { keys } = exchange();
    const secret = "account-number-4417";
    const sealed = seal(keys.a.seal, bytes(secret), sealNonce());
    expect(text(sealed)).not.toContain(secret);
    expect(Buffer.from(sealed).includes(Buffer.from(secret))).toBe(false);
  });

  test("is refused rather than opened when a single byte of it changed", () => {
    const { keys } = exchange();
    const sealed = seal(keys.a.seal, bytes("transfer 100"), sealNonce());
    const tampered = Uint8Array.from(sealed);
    if (tampered[30] !== undefined) tampered[30] ^= 0xff;
    expect(unseal(keys.b.open, tampered).isErr()).toBe(true);
  });

  test("never repeats itself, so the same frame twice is not visible as the same frame", () => {
    const { keys } = exchange();
    const once = seal(keys.a.seal, bytes("ping"), sealNonce());
    const twice = seal(keys.a.seal, bytes("ping"), sealNonce());
    expect(once).not.toEqual(twice);
    expect(text(unseal(keys.b.open, twice).unwrap())).toBe("ping");
  });
});
