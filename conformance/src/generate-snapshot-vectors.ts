/**
 * Regenerates conformance/snapshot-vectors.json from fixed seeds. Run only when the join exchange
 * deliberately changes (README rule 3): `bun conformance/src/generate-snapshot-vectors.ts`.
 *
 * The join exchange (RFC-0019, D46) as both runtimes must run it (gap U31). A holder folds a
 * fixed set of signed events and serves state: `served` freezes the frames it sends for each
 * request, byte for byte. Each `joins` case is a fresh joiner asking under one policy and taking
 * those frames: what it sent back, what it installed, and what coverage it adopted. A port that
 * holds the same events must serve the same bytes, and a port that takes the same frames must
 * reach the same coverage.
 *
 * Cells are written in column order, tables and keys in sorted order and authors in id order, so
 * the TypeScript's insertion-ordered maps and a port's sorted ones see the same order — except in
 * `unsorted`, whose point is a record whose cells are not, which only a joiner takes.
 */
import { ACME, part } from "./policy/schema.js";
import {
  A,
  B,
  HOLDER,
  ISSUER,
  JOINER,
  ROWS_PER_CHUNK,
  history,
  serve,
  unsortedHistory,
} from "./snapshot/holder.js";
import { join, type JoinCase } from "./snapshot/joiner.js";

export async function snapshotVectors() {
  const served = {
    everything: await serve(undefined),
    acme: await serve({ partitions: [part(String(ACME))] }),
    certified: await serve(undefined, 2),
    // served by a holder of other events: a port's holder of `events` does not serve this one
    unsorted: await serve(undefined, 2, unsortedHistory()),
  };
  const below = (n: number) => [[A.peerId, n]] as const;
  const cases: readonly JoinCase[] = [
    {
      description: "a cold join takes the rows and adopts nothing",
      served: "everything",
      policy: { adoptUnvouched: false },
    },
    {
      description: "a rebuild adopts the sender's coverage",
      served: "everything",
      policy: { adoptUnvouched: true },
    },
    { description: "a manifest nobody asked for installs nothing (U20)", served: "everything" },
    {
      description: "unasked, with trust set, installs nothing either",
      served: "certified",
      trust: true,
    },
    {
      description: "a scoped answer adopts its slice, scoped",
      served: "acme",
      policy: { adoptUnvouched: true },
    },
    {
      description: "a vouched answer adopts what the certificate signs, not the manifest's at",
      served: "certified",
      policy: { adoptUnvouched: false },
      trust: true,
    },
    {
      description: "a certificate over cells that arrived out of column order still vouches",
      served: "unsorted",
      policy: { adoptUnvouched: false },
      trust: true,
    },
    {
      description: "a certificate nobody trusts vouches for nothing",
      served: "certified",
      policy: { adoptUnvouched: false },
    },
    {
      description: "an accepted floor adopts per author at most the floor, and nothing else",
      served: "everything",
      policy: { adoptUnvouched: true, floor: below(2) },
    },
    {
      description: "a floor answer on a schema with document columns adopts nothing",
      served: "everything",
      policy: { adoptUnvouched: true, floor: below(2) },
      docs: true,
    },
    {
      description: "a lost page is named at the last one and sent again",
      served: "everything",
      policy: { adoptUnvouched: true },
      drop: [0],
    },
  ];
  const joins = [];
  for (const spec of cases) joins.push(await join(spec, served));
  return {
    holder: HOLDER.peerId,
    joiner: JOINER.peerId,
    issuer: ISSUER.peerId,
    authors: [A.peerId, B.peerId],
    rowsPerChunk: ROWS_PER_CHUNK,
    docs: { boards: { content: "loro@1" } },
    events: history(),
    served,
    joins,
  };
}

if (import.meta.main) {
  const out = new URL("../snapshot-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(await snapshotVectors(), null, 2)}\n`);
}
