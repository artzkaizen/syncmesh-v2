/**
 * Regenerates conformance/fragment-vectors.json. Run only when the BLE fragment header
 * deliberately changes (README rule 3): `bun conformance/src/generate-fragment-vectors.ts`.
 *
 * A `FrameLink` promises whole frames; a radio offers writes of a couple of hundred bytes. The
 * header that bridges the two is eight bytes on every fragment, the only one of a short frame
 * included, so nothing ever has to guess whether bytes are a header. A port that cuts these
 * frames into these fragments, and puts the fragments back in any order, speaks the radio.
 */
import { HEADER_BYTES, fragment } from "@syncmesh/ble";
import { bytesToHex } from "@syncmesh/wire";

const LONG = Uint8Array.from({ length: 100 }, (_, i) => i);
const SHORT = Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x01);

export function fragmentVectors() {
  const cases = [
    {
      description: "a 100-byte frame at a 40-byte write: three full fragments and a 4-byte tail",
      frame: LONG,
      limit: 40,
      message: 0xdeadbeef,
    },
    {
      description: "a 5-byte frame: one fragment, still with its header",
      frame: SHORT,
      limit: 20,
      message: 1,
    },
    {
      description: "an empty frame: one header and nothing after it",
      frame: new Uint8Array(0),
      limit: 20,
      message: 2,
    },
    {
      description: "the largest message id, so the u32 goes out unsigned",
      frame: SHORT,
      limit: 64,
      message: 0xffffffff,
    },
  ];
  return {
    headerBytes: HEADER_BYTES,
    layout: "[u32 message][u16 index][u16 total], big-endian; every fragment carries one",
    vectors: cases.map((c) => ({
      description: c.description,
      frameHex: bytesToHex(c.frame),
      limit: c.limit,
      message: c.message,
      fragmentsHex: fragment(c.frame, c.limit, c.message)
        .unwrap()
        .map((part) => bytesToHex(part)),
    })),
    /** What a port must refuse, as a value: the inputs and the error's tag. */
    refusals: [
      {
        description: "a write limit that leaves no room for a header",
        frameBytes: 5,
        limit: 8,
        error: "LimitTooSmall",
      },
      {
        description: "a frame that would need more than 65535 fragments",
        frameBytes: 65_536,
        limit: 9,
        error: "FrameTooLarge",
      },
    ],
  };
}

if (import.meta.main) {
  const out = new URL("../fragment-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(fragmentVectors(), null, 2)}\n`);
}
