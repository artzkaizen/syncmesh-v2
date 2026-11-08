import type { Cursors } from "@syncmesh/engine";

import {
  BELOW_FLOOR,
  REGRANTED,
  REGRANTED_MESSAGE,
  REVOKED,
  REVOKED_MESSAGE,
  UNGRANTED,
  UNGRANTED_MESSAGE,
  errorFrame,
  pageFrame,
} from "@syncmesh/relay";
import { bytesToHex } from "@syncmesh/wire";

/** D40's grant-gated room: its three typed refusals, and the live notice of an event passed over. */
const grantGateVectors = (cursors: Cursors) => [
  {
    description:
      "error, the typed gate refusal: a gated room holds no grant from an issuer it trusts for this key (D40)",
    kind: "error",
    tag: 10,
    wireHex: bytesToHex(errorFrame(UNGRANTED, UNGRANTED_MESSAGE)),
  },
  {
    description:
      "error, a newer grant narrowed what this socket may read, or its grant lapsed: re-join (D40)",
    kind: "error",
    tag: 10,
    wireHex: bytesToHex(errorFrame(REVOKED, REVOKED_MESSAGE)),
  },
  {
    description: "error, a newer grant widened what this socket may read: re-join (D40)",
    kind: "error",
    tag: 10,
    wireHex: bytesToHex(errorFrame(REGRANTED, REGRANTED_MESSAGE)),
  },
  {
    description:
      "page, empty and last, carrying only a scoped coverage: live fan-out passed an event over, and the author's run is held up to it (D23, D40)",
    kind: "page",
    tag: 13,
    wireHex: bytesToHex(
      pageFrame([], [], false, 9, {
        synced: cursors,
        local: new Map(),
        scope: '{"partitions":["org:acme"]}',
      }),
    ),
  },
];

/** The retention refusal, naming the room's floor so the device can say what it is below (gaps U30). */
const retentionVectors = (floor: Cursors) => [
  {
    description:
      "error, the typed retention refusal naming the room's floor, so the device can say what it is below and stop dialling (gaps U30)",
    kind: "error",
    tag: 10,
    wireHex: bytesToHex(errorFrame("retention", BELOW_FLOOR, floor)),
  },
];

/**
 * The typed refusals a room speaks beyond a version or a proof, in the order they were frozen:
 * D40's gate, then the retention floor. Appended to `relay-vectors.json` last, so no earlier
 * vector moves.
 */
export const refusalVectors = (cursors: Cursors, floor: Cursors) => [
  ...grantGateVectors(cursors),
  ...retentionVectors(floor),
];
