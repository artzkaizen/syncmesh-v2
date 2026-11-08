import type { Interest } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

import { omitUndefined } from "@syncmesh/result";

import type { BridgeOptions } from "./bridge.js";
import type { JoinDeps } from "./join.js";

import { createJoinExchange } from "./join.js";
import { createRejoins } from "./rejoin.js";

/**
 * The join exchange for one session, carrying only the options the caller actually set, and the
 * session's view of the mesh's rejoin record (D46), which asks through that exchange.
 */
export const createSessionJoin = (
  options: BridgeOptions,
  send: JoinDeps["send"],
  reader: () => PeerId | undefined,
  onRefused: NonNullable<JoinDeps["onRefused"]>,
) => {
  const { engine, identity, rowsPerChunk, onSnapshot, certificate, trust } = options;
  const { readGate, withheld } = options;
  // a snapshot is rows in the clear: served only under what the asker may read (D40)
  const served =
    readGate === undefined
      ? {}
      : { serves: (asked?: Interest) => readGate.serves(reader(), asked) };
  const base = { engine, send, onRefused, idPrefix: identity.peerId.slice(0, 8), ...served };
  const gated = withheld === undefined ? base : { ...base, withheld };
  const paged = rowsPerChunk === undefined ? gated : { ...gated, rowsPerChunk };
  const reported = onSnapshot === undefined ? paged : { ...paged, onSnapshot };
  const vouching = certificate === undefined ? reported : { ...reported, certificate };
  const join = createJoinExchange(trust === undefined ? vouching : { ...vouching, trust });
  const rejoin = (options.rejoins ?? createRejoins()).session({
    engine,
    trusted: trust !== undefined,
    request: join.requestUnder,
    ...omitUndefined({ interest: options.interest }),
  });
  return { join, rejoin };
};
