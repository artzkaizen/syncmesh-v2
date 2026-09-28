import type { SuiteCase } from "@syncmesh/engine";

import { check, equal } from "@syncmesh/engine";

import type { ByteStream } from "../framing.js";

import { framed } from "../framing.js";

/**
 * The contract a medium's channel has to satisfy, below everything a mesh does with it.
 *
 * The other suite in this package asks whether events converge. This one asks whether the pipe
 * is a pipe — and the distinction is not academic. Both real defects found while building the
 * LAN and Wi-Fi adapters were in this layer: a second connection opened to a peer whose first
 * dial had not landed, and bytes buffered before a reader attached being handed over *after*
 * bytes that arrived later. Neither is visible in a convergence test until something far away
 * fails to appear, and both are one assertion away from obvious here.
 *
 * Modelled on libp2p's `interface-compliance-tests/transport`, which tests exactly this: small
 * writes, one big write, many writes, and what happens around a close. A stand-in that passes
 * these behaves like a socket; one that does not will fail a mesh in a way nobody can read.
 */

/** Two ends of one channel, however the medium makes them. */
export type OpenChannel = () => Promise<{
  readonly a: ByteStream;
  readonly b: ByteStream;
  /** Bytes in flight settle. */
  readonly settle: () => Promise<void>;
  readonly close: () => void;
}>;

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Everything `stream` delivers, in the order it was delivered. */
const collect = (stream: ByteStream) => {
  const link = framed(stream);
  const frames: string[] = [];
  link.onFrame((frame) => void frames.push(text(frame)));
  return { frames };
};

const sender = (stream: ByteStream) => framed(stream);

export function channelTests(open: OpenChannel): readonly SuiteCase[] {
  return [
    {
      name: "channel: one small write arrives whole",
      run: async () => {
        const channel = await open();
        const heard = collect(channel.b);
        sender(channel.a).send(bytes("hello"));
        await channel.settle();
        equal(heard.frames.join(), "hello", "the frame");
        channel.close();
      },
    },
    {
      name: "channel: many small writes arrive, in the order they were written",
      run: async () => {
        const channel = await open();
        const heard = collect(channel.b);
        const link = sender(channel.a);
        const written = Array.from({ length: 200 }, (_, i) => `frame-${String(i)}`);
        for (const word of written) link.send(bytes(word));
        await channel.settle();
        equal(heard.frames.length, written.length, "frames delivered");
        equal(heard.frames.join("|"), written.join("|"), "delivery order");
        channel.close();
      },
    },
    {
      name: "channel: one big write arrives whole, however the medium splits it",
      run: async () => {
        const channel = await open();
        const heard = collect(channel.b);
        // a megabyte: past any sane buffer, so a medium that chunks has to chunk it
        const big = "x".repeat(1024 * 1024);
        sender(channel.a).send(bytes(big));
        await channel.settle();
        equal(heard.frames.length, 1, "frames delivered");
        equal(heard.frames[0]?.length, big.length, "bytes delivered");
        channel.close();
      },
    },
    {
      name: "channel: both ends can write at once without crossing",
      run: async () => {
        const channel = await open();
        const atA = collect(channel.a);
        const atB = collect(channel.b);
        const [toB, toA] = [sender(channel.a), sender(channel.b)];
        for (let i = 0; i < 50; i += 1) {
          toB.send(bytes(`a${String(i)}`));
          toA.send(bytes(`b${String(i)}`));
        }
        await channel.settle();
        equal(atB.frames.length, 50, "frames at b");
        equal(atA.frames.length, 50, "frames at a");
        check(
          atB.frames.every((frame) => frame.startsWith("a")),
          "b heard only what a wrote",
        );
        check(
          atA.frames.every((frame) => frame.startsWith("b")),
          "a heard only what b wrote",
        );
        channel.close();
      },
    },
    {
      name: "channel: bytes written before a reader attaches are not lost, and not reordered",
      run: async () => {
        // the defect this exists for: a peer's hello arrives before the reader is attached, and a
        // stand-in that flushes it late delivers the sealed frames that follow it *first* — after
        // which the session never opens and nothing says why
        const channel = await open();
        const link = sender(channel.a);
        link.send(bytes("first"));
        link.send(bytes("second"));
        await channel.settle();
        const heard = collect(channel.b);
        link.send(bytes("third"));
        await channel.settle();
        equal(heard.frames.join("|"), "first|second|third", "delivery order across the gap");
        channel.close();
      },
    },
    {
      name: "channel: a write to a closed channel throws, rather than vanishing",
      run: async () => {
        // RFC-0005's rule, at the bottom of the stack: a loud failure is recoverable by resync,
        // a silent one is two devices believing different things
        const channel = await open();
        channel.a.close();
        await channel.settle();
        let threw = false;
        try {
          sender(channel.a).send(bytes("after the close"));
        } catch {
          threw = true;
        }
        check(threw, "the write failed loudly");
        channel.close();
      },
    },
    {
      name: "channel: closing one end is seen by both",
      run: async () => {
        const channel = await open();
        let closedA = false;
        let closedB = false;
        channel.a.onClose(() => void (closedA = true));
        channel.b.onClose(() => void (closedB = true));
        channel.a.close();
        await channel.settle();
        check(closedA, "the end that closed heard it");
        check(closedB, "the far end heard it");
        channel.close();
      },
    },
    {
      name: "channel: nothing arrives after the far end has gone",
      run: async () => {
        const channel = await open();
        const heard = collect(channel.b);
        channel.b.close();
        await channel.settle();
        try {
          sender(channel.a).send(bytes("into the void"));
        } catch {
          // a medium that refuses the write is behaving; one that accepts it must not deliver
        }
        await channel.settle();
        equal(heard.frames.length, 0, "frames after close");
        channel.close();
      },
    },
  ];
}
