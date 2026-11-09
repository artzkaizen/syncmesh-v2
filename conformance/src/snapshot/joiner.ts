/** The snapshot vectors' joiners (gap U31): one fresh device per case, asking under one policy. */
import type { Cursors } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import {
  createJoinExchange,
  decodeFrame,
  type JoinExchange,
  type JoinOutcome,
  type JoinPolicy,
} from "@syncmesh/transport";
import { hexToBytes } from "@syncmesh/wire";

import { table } from "../policy/schema.js";
import { DOCS, ISSUER, JOINER, collector, engineFor, pairs } from "./holder.js";

export interface JoinCase {
  readonly description: string;
  /** Which `served` entry the joiner takes. */
  readonly served: string;
  /** Absent: the joiner never asks, and the frames arrive unasked. */
  readonly policy?: {
    readonly adoptUnvouched: boolean;
    readonly floor?: readonly (readonly [PeerId, number])[];
  };
  readonly trust?: boolean;
  readonly docs?: boolean;
  /** Chunk indexes lost on the way, delivered once the joiner's ack names them. */
  readonly drop?: readonly number[];
}

/** The policy a case asks under, telling `outcomes` how it settled. */
const policyOf = (spec: NonNullable<JoinCase["policy"]>, outcomes: JoinOutcome[]): JoinPolicy => {
  const floor: Cursors | undefined =
    spec.floor === undefined
      ? undefined
      : // SAFETY: every floor a case writes is a positive integer, which is all a sequence number is
        new Map(spec.floor.map(([p, s]) => [p, s as SeqNum]));
  return {
    adoptUnvouched: spec.adoptUnvouched,
    ...(floor !== undefined && { floor }),
    settled: (outcome) => outcomes.push(outcome),
  };
};

/** Hands the served frames over in order, holding back the chunks `drop` names until the end. */
async function deliver(
  exchange: JoinExchange,
  frames: readonly string[],
  drop: readonly number[],
): Promise<void> {
  const decoded = frames.map((hex) => decodeFrame(hexToBytes(hex).unwrap()).unwrap());
  const lost = (frame: (typeof decoded)[number]) =>
    frame.kind === "snap-chunk" && drop.includes(frame.index);
  for (const frame of [...decoded.filter((f) => !lost(f)), ...decoded.filter(lost)])
    if (frame.kind === "snap-manifest" || frame.kind === "snap-chunk")
      await exchange.dispatch(frame);
}

const outcomeOf = (settled: JoinOutcome | undefined) => {
  if (settled === undefined) return null;
  if (settled.kind === "refused") return { kind: "refused" };
  return { kind: "installed", rows: settled.installed.rows, vouched: settled.vouched };
};

/** One joiner taking one served set of frames under one policy, as the TypeScript does it. */
export async function join(
  spec: JoinCase,
  served: Readonly<Record<string, { readonly frames: readonly string[] }>>,
) {
  const engine = engineFor(JOINER.peerId, spec.docs === true ? DOCS : undefined);
  const out = collector();
  const outcomes: JoinOutcome[] = [];
  const exchange = createJoinExchange({
    engine,
    send: out.send,
    idPrefix: "joiner",
    ...(spec.trust === true && { trust: ISSUER.peerId }),
  });
  if (spec.policy !== undefined) exchange.requestUnder(undefined, policyOf(spec.policy, outcomes));
  const request = out.sent.splice(0);
  await deliver(exchange, served[spec.served]?.frames ?? [], spec.drop ?? []);
  const coverage = engine.coverage();
  return {
    ...spec,
    request: request[0] ?? null,
    sent: out.sent,
    synced: pairs(coverage.synced),
    floor: pairs(coverage.floor),
    // the slice the adopted cursors are true for: a window travels with them (D23, O13)
    scope: coverage.scope ?? null,
    rows: [...(engine.state().get(table("notes"))?.keys() ?? [])].map(String).sort(),
    settled: outcomeOf(outcomes[0]),
  };
}
