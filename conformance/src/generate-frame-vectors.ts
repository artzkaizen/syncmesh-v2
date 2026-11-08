/**
 * Regenerates conformance/frame-vectors.json from fixed seeds. Run only when a session frame
 * deliberately changes (README rule 3): `bun conformance/src/generate-frame-vectors.ts`.
 *
 * The session frames are what every transport carries — WebSocket relay, LAN, BLE, AWDL — and
 * the four-byte length prefix is how a byte stream carries them. A port that reproduces these
 * bytes from the same inputs, and decodes each back to the named kind, speaks the session.
 */
import {
  DEFAULT_MAX_FRAME_BYTES,
  LENGTH_BYTES,
  cursorsFrame,
  digestFrame,
  eventFrame,
  grantFrame,
  grantRequestFrame,
  presenceFrame,
  receiptFrame,
  refusalFrame,
  routesFrame,
  withheldFrame,
  snapAckFrame,
  snapChunkFrame,
  snapManifestFrame,
  snapRequestFrame,
} from "@syncmesh/transport";
import { bytesToHex } from "@syncmesh/wire";

import { ACME, frameInputs } from "./frame-inputs.js";

const ACME_ONLY = { partitions: [ACME] } as const;
const PAYLOAD = Uint8Array.from({ length: 8 }, (_, i) => 0xa0 + i);

/** The frame with the four-byte big-endian length a byte stream carries it under. */
const framed = (frame: Uint8Array): Uint8Array => {
  const out = new Uint8Array(LENGTH_BYTES + frame.length);
  new DataView(out.buffer).setUint32(0, frame.length);
  out.set(frame, LENGTH_BYTES);
  return out;
};

/** One case per frame kind and shape, built from {@link frameInputs}. */
function frameCases(fx: ReturnType<typeof frameInputs>) {
  const cases: readonly { description: string; kind: string; tag: number; wire: Uint8Array }[] = [
    {
      description: "grant, carrying a frozen grant wire",
      kind: "grant",
      tag: 0,
      wire: grantFrame(fx.grantWire),
    },
    {
      description: "grant-request, no invite",
      kind: "grant-request",
      tag: 1,
      wire: grantRequestFrame(fx.device.peerId),
    },
    {
      description: "grant-request with an invite",
      kind: "grant-request",
      tag: 1,
      wire: grantRequestFrame(fx.device.peerId, "inv-7"),
    },
    {
      description: "cursors, two authors",
      kind: "cursors",
      tag: 2,
      wire: cursorsFrame(fx.device.peerId, fx.cursors),
    },
    {
      description: "cursors with what is held above them (D13)",
      kind: "cursors",
      tag: 2,
      wire: cursorsFrame(fx.device.peerId, fx.cursors, fx.ahead),
    },
    {
      description: "event, carrying a frozen event wire",
      kind: "event",
      tag: 3,
      wire: eventFrame(fx.eventWire),
    },
    {
      description: "presence, a signed cursor position",
      kind: "presence",
      tag: 4,
      wire: presenceFrame(fx.presence),
    },
    {
      description: "digest of the whole state",
      kind: "digest",
      tag: 5,
      wire: digestFrame("", fx.cursors, fx.digests),
    },
    {
      description: "digest of one partition, with ahead",
      kind: "digest",
      tag: 5,
      wire: digestFrame(JSON.stringify(ACME_ONLY), fx.cursors, fx.digests, fx.ahead),
    },
    {
      description: "snapshot request, everything",
      kind: "snap-req",
      tag: 6,
      wire: snapRequestFrame(),
    },
    {
      description: "snapshot request, one partition",
      kind: "snap-req",
      tag: 6,
      wire: snapRequestFrame(ACME_ONLY),
    },
    {
      description: "snapshot manifest, whole state, no certificate",
      kind: "snap-manifest",
      tag: 6,
      wire: snapManifestFrame("snap-1", 2, 5, fx.cursors),
    },
    {
      description: "snapshot manifest, one partition, with a certificate",
      kind: "snap-manifest",
      tag: 6,
      wire: snapManifestFrame("snap-1", 2, 5, fx.cursors, ACME_ONLY, fx.certificate),
    },
    {
      description: "snapshot chunk",
      kind: "snap-chunk",
      tag: 6,
      wire: snapChunkFrame("snap-1", 0, PAYLOAD),
    },
    {
      description: "snapshot ack, complete",
      kind: "snap-ack",
      tag: 6,
      wire: snapAckFrame("snap-1", []),
    },
    {
      description: "snapshot ack, one chunk missing",
      kind: "snap-ack",
      tag: 6,
      wire: snapAckFrame("snap-1", [1]),
    },
    {
      description: "receipt, carrying a frozen custody receipt",
      kind: "receipt",
      tag: 7,
      wire: receiptFrame(fx.receiptWire),
    },
    {
      description: "routes, one destination two hops away",
      kind: "routes",
      tag: 8,
      wire: routesFrame(fx.ads),
    },
    {
      description: "refusal, carrying a frozen refusal receipt (D32)",
      kind: "refusal",
      tag: 9,
      wire: refusalFrame(fx.refusalWire),
    },
    {
      description:
        "withheld, two sequences of one author the receiver's grant does not cover, under its entitlement (D40)",
      kind: "withheld",
      tag: 10,
      wire: withheldFrame('{"partitions":["org:acme"]}', fx.ahead),
    },
    // D46: the sender's compaction floor at index 4, with `ahead` always present at index 3 so an
    // older build, which reads index 3 strictly and ignores the rest, still takes the frame
    {
      description: "cursors with a compaction floor and nothing held above them (D46)",
      kind: "cursors",
      tag: 2,
      wire: cursorsFrame(fx.device.peerId, fx.cursors, undefined, fx.floor),
    },
    {
      description: "cursors with what is held above them and a compaction floor (D46)",
      kind: "cursors",
      tag: 2,
      wire: cursorsFrame(fx.device.peerId, fx.cursors, fx.ahead, fx.floor),
    },
  ];
  return cases;
}

export function frameVectors() {
  const fx = frameInputs();
  const cases = frameCases(fx);
  const { device, other } = fx;
  const example = grantRequestFrame(device.peerId, "inv-7");
  return {
    deviceId: device.peerId,
    otherId: other.peerId,
    framing: {
      lengthBytes: LENGTH_BYTES,
      byteOrder: "big-endian",
      defaultMaxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
      example: { frameHex: bytesToHex(example), framedHex: bytesToHex(framed(example)) },
    },
    vectors: cases.map(({ description, kind, tag, wire }) => ({
      description,
      kind,
      tag,
      wireHex: bytesToHex(wire),
    })),
  };
}

if (import.meta.main) {
  const out = new URL("../frame-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(frameVectors(), null, 2)}\n`);
}
