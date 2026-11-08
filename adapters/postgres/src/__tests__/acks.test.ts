import { describe, expect, test } from "bun:test";

import { createAckLedger } from "../acks.js";
import { parseLsn } from "../index.js";

const at = (text: string) => parseLsn(text).unwrap();

describe("the ack ledger: what a slot may be told is flushed", () => {
  test("a delivered transaction holds the position until it is acked", () => {
    const acks = createAckLedger(at("0/10"));
    acks.delivered(at("0/20"));
    expect(acks.confirmed()).toBe(at("0/10"));
    expect(acks.ack(at("0/20"))).toBe(true);
    expect(acks.confirmed()).toBe(at("0/20"));
  });

  test("an ack releases only what was delivered, however far past it the ack reaches", () => {
    const acks = createAckLedger(at("0/10"));
    expect(acks.ack(at("FFFF/0"))).toBe(false); // nothing delivered: nothing to release
    acks.delivered(at("0/20"));
    acks.ack(at("FFFF/0"));
    expect(acks.confirmed()).toBe(at("0/20")); // the end of what was decoded, never the ack's
  });

  test("an ack between two transactions releases the first and holds the second", () => {
    const acks = createAckLedger(at("0/10"));
    acks.delivered(at("0/20"));
    acks.delivered(at("0/30"));
    acks.ack(at("0/25"));
    expect(acks.confirmed()).toBe(at("0/20"));
  });

  test("a keepalive with nothing pending moves the position: the idle slot does not grow", () => {
    const acks = createAckLedger(at("0/10"));
    acks.idle(at("0/90"));
    expect(acks.confirmed()).toBe(at("0/90"));
  });

  test("a keepalive behind an unacked transaction waits for that transaction's ack", () => {
    const acks = createAckLedger(at("0/10"));
    acks.delivered(at("0/20"));
    acks.idle(at("0/40"));
    acks.idle(at("0/50"));
    expect(acks.confirmed()).toBe(at("0/10"));
    acks.ack(at("0/20"));
    expect(acks.confirmed()).toBe(at("0/50"));
  });

  test("a keepalive between two transactions is released with the first, not past the second", () => {
    const acks = createAckLedger(at("0/10"));
    acks.delivered(at("0/20"));
    acks.idle(at("0/28"));
    acks.delivered(at("0/30"));
    acks.ack(at("0/20"));
    expect(acks.confirmed()).toBe(at("0/28"));
    acks.ack(at("0/30"));
    expect(acks.confirmed()).toBe(at("0/30"));
  });

  test("the position never goes backwards", () => {
    const acks = createAckLedger(at("0/50"));
    acks.idle(at("0/20"));
    expect(acks.confirmed()).toBe(at("0/50"));
    acks.delivered(at("0/60"));
    acks.ack(at("0/60"));
    expect(acks.ack(at("0/40"))).toBe(false);
    expect(acks.confirmed()).toBe(at("0/60"));
  });
});
