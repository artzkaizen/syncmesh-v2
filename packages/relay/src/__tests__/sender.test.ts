import { describe, expect, test } from "bun:test";

import type { RelaySocket, SendOutcome } from "../sender.js";

import { createSender } from "../sender.js";

const bytes = (n: number) => Uint8Array.of(n);

/**
 * A socket that takes `room` frames into its own buffer, reporting each as `buffered`, and then
 * `dropped` until the far end reads — a WebSocket behind a reader that stopped reading.
 */
const stalledSocket = (room: number) => {
  const buffered: number[] = [];
  const read: number[] = [];
  const socket: RelaySocket = {
    send: (frame): SendOutcome => {
      if (buffered.length >= room) return "dropped";
      buffered.push(frame[0] ?? -1);
      return "buffered";
    },
    close: () => undefined,
  };
  return {
    socket,
    /** Everything that has been put into the socket, read or not. */
    taken: () => [...read, ...buffered],
    /** The far end reads its buffer empty. */
    read: () => void read.push(...buffered.splice(0)),
  };
};

describe("Sender.sendLatest (D16)", () => {
  test("a stalled socket is handed the newest value per slot, not every value it missed", () => {
    const s = stalledSocket(1);
    const sender = createSender(s.socket, 100);
    sender.send(bytes(1)); // an event: into the socket's buffer, which is now behind
    for (let n = 10; n < 20; n += 1) sender.sendLatest("cursor a", bytes(n));
    sender.sendLatest("cursor b", bytes(30));
    sender.sendLatest("cursor b", bytes(31));
    expect(s.taken()).toEqual([1]); // nothing else joined the socket's own queue
    expect(sender.held()).toBe(2);

    s.read();
    sender.drain();
    s.read();
    sender.drain();
    // one value per slot, the newest, in the order the slots were first held
    expect(s.taken()).toEqual([1, 19, 31]);
    expect(sender.held()).toBe(0);
  });

  test("ordinary frames are never conflated and go ahead of every held value", () => {
    const s = stalledSocket(1);
    const sender = createSender(s.socket, 100);
    sender.send(bytes(1));
    sender.sendLatest("cursor", bytes(10));
    sender.send(bytes(2)); // refused by the full socket: queued in order
    sender.send(bytes(3));
    sender.sendLatest("cursor", bytes(11));
    for (let round = 0; round < 4; round += 1) {
      s.read();
      sender.drain();
    }
    expect(s.taken()).toEqual([1, 2, 3, 11]);
  });

  test("a socket that is keeping up sends each value at once", () => {
    const sent: number[] = [];
    const sender = createSender(
      { send: (frame) => (sent.push(frame[0] ?? -1), "sent"), close: () => undefined },
      100,
    );
    sender.sendLatest("cursor", bytes(1));
    sender.sendLatest("cursor", bytes(2));
    expect(sent).toEqual([1, 2]);
    expect(sender.held()).toBe(0);
  });

  test("held values count towards no ceiling: a 60 Hz cursor never closes a stalled socket", () => {
    let closed = false;
    const sender = createSender(
      {
        send: () => "dropped",
        close: () => void (closed = true),
      },
      3,
      64,
    );
    for (let n = 0; n < 1000; n += 1) sender.sendLatest("cursor", bytes(n % 256));
    expect(closed).toBe(false);
    expect(sender.held()).toBe(1);
    expect(sender.backlog()).toBe(0);
  });
});
