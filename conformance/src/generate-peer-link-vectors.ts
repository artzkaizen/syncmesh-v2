/**
 * Regenerates conformance/peer-link-vectors.json from fixed seeds. Run only when the peer session
 * deliberately changes (README rule 3): `bun conformance/src/generate-peer-link-vectors.ts`.
 *
 * The session a peer link carries once its handshake is done (`bridgeFramedLink`, gap U3's
 * radios), as both runtimes must run it. A holder folds the snapshot vectors' history and opens a
 * session with the joiner: `open` freezes the plaintext frames it sends unprompted, and each
 * `answers` case the frames it sends back to one cursors frame — the events the joiner lacks, the
 * ones it holds above its cursor left out, a digest of the holder's rows over the session's slice,
 * and the holder's own cursors when the joiner is ahead of it. `receives` is the other half: a
 * fresh device taking event frames out of order, with what it sends after each (the gap rule
 * holds an event past a hole; a fold is announced with the device's cursors).
 *
 * Authors are in id order and there is one table, so the TypeScript's insertion-ordered maps and a
 * port's sorted ones write the same bytes: a port must match these byte for byte.
 */
import type { Engine, Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { parseSeqNum } from "@syncmesh/kernel";
import { bridgeFramedLink, cursorsFrame, eventFrame, type FrameLink } from "@syncmesh/transport";
import { bytesToHex, createGrantRegistry, decodeAndVerify, hexToBytes } from "@syncmesh/wire";

import { ACME, NOW, part } from "./policy/schema.js";
import { A, B, HOLDER, JOINER, engineFor, history } from "./snapshot/holder.js";

/** A link that keeps what the bridge sends, and hands it frames as the far side would. */
const capture = () => {
  const sent: string[] = [];
  let deliver: (frame: Uint8Array) => void = () => undefined;
  const link: FrameLink = {
    send: (frame) => void sent.push(bytesToHex(frame)),
    onFrame: (cb) => {
      deliver = cb;
      return () => undefined;
    },
  };
  return { link, sent, deliver: (hex: string) => deliver(hexToBytes(hex).unwrap()) };
};

/** A session on `engine` as `self`, with `peer` on the far side. */
const bridged = (engine: Engine, self: typeof HOLDER, peer: PeerId, interest?: Interest) => {
  const wire = capture();
  const bridge = bridgeFramedLink(wire.link, {
    engine,
    identity: self,
    grants: createGrantRegistry({ issuer: self.peerId, now: () => NOW }),
    now: () => NOW,
    peer,
    ...(interest !== undefined && { interest }),
  });
  /** Everything queued has left: the fold, and the cursors queued behind it. */
  const settle = async (): Promise<readonly string[]> => {
    for (let i = 0; i < 5; i += 1) {
      await bridge.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return wire.sent.splice(0);
  };
  return { bridge, settle, deliver: wire.deliver };
};

/** The holder: the snapshot vectors' history, folded. */
async function holder(): Promise<Engine> {
  const engine = engineFor(HOLDER.peerId);
  const entries = history().map((hex) => decodeAndVerify(hexToBytes(hex).unwrap()).unwrap());
  (await engine.receiveBatch(entries)).unwrap();
  return engine;
}

const seq = (n: number): SeqNum => parseSeqNum(n).unwrap();
type Position = readonly (readonly [PeerId, number])[];
const at = (position: Position) => new Map(position.map(([peer, n]) => [peer, seq(n)] as const));
const above = (position: readonly (readonly [PeerId, readonly number[]])[]) =>
  new Map(position.map(([peer, ns]) => [peer, ns.map(seq)] as const));

interface AnswerCase {
  readonly description: string;
  readonly interest?: Interest;
  readonly cursors: Position;
  readonly ahead?: readonly (readonly [PeerId, readonly number[]])[];
}

/** One session per case: what it opens with, and its answer to the joiner's cursors. */
async function answer(spec: AnswerCase) {
  const session = bridged(await holder(), HOLDER, JOINER.peerId, spec.interest);
  const open = await session.settle();
  const cursors = bytesToHex(
    cursorsFrame(
      JOINER.peerId,
      at(spec.cursors),
      spec.ahead === undefined ? undefined : above(spec.ahead),
    ),
  );
  session.deliver(cursors);
  const sent = await session.settle();
  session.bridge.close();
  return {
    description: spec.description,
    interest: spec.interest ?? null,
    open,
    cursors,
    sent,
  };
}

/**
 * The history's events as frames, handed to a fresh device in `order` (indexes into `events`),
 * with what it sends after each.
 */
async function receive(description: string, order: readonly number[]) {
  const events = history();
  const session = bridged(engineFor(JOINER.peerId), JOINER, HOLDER.peerId);
  const open = await session.settle();
  const steps = [];
  for (const index of order) {
    const frame = bytesToHex(eventFrame(hexToBytes(events[index] ?? "").unwrap()));
    session.deliver(frame);
    steps.push({ index, frame, sent: await session.settle() });
  }
  session.bridge.close();
  return { description, open, steps };
}

export async function peerLinkVectors() {
  const answers = [];
  const cases: readonly AnswerCase[] = [
    { description: "a joiner holding nothing is sent the whole history and a digest", cursors: [] },
    {
      description:
        "a joiner partway along is sent the rest, less what it holds above its cursor (D13)",
      cursors: [
        [A.peerId, 1],
        [B.peerId, 1],
      ],
      ahead: [[B.peerId, [3]]],
    },
    {
      description: "a joiner at the holder's position is sent a digest it can compare",
      cursors: [
        [A.peerId, 3],
        [B.peerId, 3],
      ],
      ahead: [],
    },
    {
      description:
        "a joiner ahead of the holder on an author is answered with the holder's cursors",
      cursors: [
        [A.peerId, 3],
        [B.peerId, 5],
      ],
    },
    {
      description: "a session with an interest digests only the rows in its slice",
      interest: { partitions: [part(String(ACME))] },
      cursors: [
        [A.peerId, 3],
        [B.peerId, 3],
      ],
      ahead: [],
    },
  ];
  for (const spec of cases) answers.push(await answer(spec));
  return {
    holder: HOLDER.peerId,
    joiner: JOINER.peerId,
    authors: [A.peerId, B.peerId],
    events: history(),
    answers,
    receives: [
      await receive("a run in order folds one event at a time, each announced", [0, 1, 2]),
      await receive("an event past a hole waits for it, then the run folds whole", [1, 2, 0]),
      await receive("an event already held is taken once and announced once", [3, 3, 4]),
    ],
  };
}

if (import.meta.main) {
  const out = new URL("../peer-link-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(await peerLinkVectors(), null, 2)}\n`);
}
