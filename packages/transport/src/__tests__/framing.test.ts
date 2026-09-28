import { describe, expect, test } from "bun:test";

import type { ByteStream } from "../framing.js";

import { framed } from "../framing.js";

/** A stream a test drives both ends of: what was written, and what it decides to deliver. */
const stub = () => {
  const written: Uint8Array[] = [];
  const data = new Set<(b: Uint8Array) => void>();
  const closes = new Set<() => void>();
  let closed = false;
  const stream: ByteStream = {
    write: (bytes) => {
      if (closed) throw new Error("closed");
      written.push(bytes);
    },
    onData: (cb) => {
      data.add(cb);
      return () => void data.delete(cb);
    },
    onClose: (cb) => {
      closes.add(cb);
      return () => void closes.delete(cb);
    },
    close: () => {
      closed = true;
      for (const cb of closes) cb();
    },
  };
  return {
    stream,
    written,
    closed: () => closed,
    deliver: (bytes: Uint8Array) => {
      for (const cb of data) cb(bytes);
    },
  };
};

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("frame boundaries over a medium that has none", () => {
  test("three frames arriving as one read come out as three", () => {
    const wire = stub();
    const link = framed(wire.stream);
    const got: string[] = [];
    link.onFrame((frame) => void got.push(text(frame)));

    for (const word of ["one", "two", "three"]) link.send(bytes(word));
    const joined = new Uint8Array(wire.written.reduce((n, w) => n + w.length, 0));
    let at = 0;
    for (const chunk of wire.written) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    wire.deliver(joined);

    expect(got).toEqual(["one", "two", "three"]);
  });

  test("one frame arriving a byte at a time comes out once, whole", () => {
    const wire = stub();
    const link = framed(wire.stream);
    const got: string[] = [];
    link.onFrame((frame) => void got.push(text(frame)));

    link.send(bytes("a frame split across many reads"));
    const sent = wire.written[0] ?? new Uint8Array(0);
    for (const byte of sent) wire.deliver(Uint8Array.of(byte));

    expect(got).toEqual(["a frame split across many reads"]);
  });

  test("a stranger claiming a huge frame closes the link instead of being believed", () => {
    const wire = stub();
    const dropped: string[] = [];
    const link = framed(wire.stream, {
      maxFrameBytes: 64,
      onDropped: (why) => void dropped.push(why),
    });
    const got: string[] = [];
    link.onFrame((frame) => void got.push(text(frame)));

    // four bytes anyone can write, before a handshake, claiming four gigabytes follow
    wire.deliver(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
    expect(wire.closed()).toBe(true);
    expect(dropped[0]).toContain("this link holds 64");

    // and nothing after it is read: a stream whose lengths lie has no next frame worth having
    wire.deliver(Uint8Array.of(0, 0, 0, 2, 104, 105));
    expect(got).toEqual([]);
  });

  test("a frame too big to send fails loudly here, rather than on the far end's floor", () => {
    const wire = stub();
    const link = framed(wire.stream, { maxFrameBytes: 8 });
    expect(() => link.send(bytes("nine char"))).toThrow("the link holds 8");
  });

  test("a write that did not leave throws, because a silent loss is divergence", () => {
    const wire = stub();
    const link = framed(wire.stream);
    wire.stream.close();
    expect(() => link.send(bytes("x"))).toThrow();
  });
});
