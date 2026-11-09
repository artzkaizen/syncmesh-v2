import { portableSchema } from "@syncmesh/schema";

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
 * Tables and keys are written in sorted order and authors in id order, so the TypeScript's
 * insertion-ordered maps and a port's sorted ones see the same order. A record's cells go out in
 * column order in both runtimes (gaps U34), so `unsorted` — a row whose cells were first written
 * out of that order — is served as the same bytes by a holder in either. `legacy` is that page as
 * a holder built before U34 served it, cells out of column order, and `stale` the certified frames
 * with the certificate re-signed as version 1: a joiner still vouches for the first and refuses
 * the second. `local` is served by a holder that wrote a row to a `local` table (gaps U36), which
 * its frames leave out: they are `everything`'s, byte for byte. Each join reports the floor its
 * log kept for a rebuild to refuse on (`installed`, gaps U37). `documented` is served by a holder
 * whose pages carry its rows' document checkpoints (version 2, E30 P5): a port decodes and
 * re-encodes each page to the bytes sent, checkpoints and completeness included.
 */
import { ACME, part } from "./policy/schema.js";
import {
  A,
  B,
  DOCUMENTED,
  DRAFT,
  HOLDER,
  ISSUER,
  JOINER,
  ROWS_PER_CHUNK,
  SNAPSHOT_SCHEMA,
  certifiedAs,
  history,
  outOfColumnOrder,
  serve,
  unsortedHistory,
} from "./snapshot/holder.js";
import { join, type JoinCase } from "./snapshot/joiner.js";

export async function snapshotVectors() {
  const unsorted = await serve(undefined, 2, unsortedHistory());
  const certified = await serve(undefined, 2);
  const served = {
    everything: await serve(undefined),
    acme: await serve({ partitions: [part(String(ACME))] }),
    // the newest acme row and acme's tombstone: a window is part of the interest (O13)
    windowed: await serve({ partitions: [part(String(ACME))], window: { newest: 1 } }),
    certified,
    // served by a holder of other events: a port's holder of `events` does not serve this one
    unsorted,
    legacy: { request: unsorted.request, frames: outOfColumnOrder(unsorted.frames) },
    stale: { request: certified.request, frames: certifiedAs(certified.frames, 1) },
    local: await serve(undefined, undefined, history(), true),
    // version 2 pages: each carries its rows' document checkpoints (RFC-0023 §5.5, E30 P5)
    documented: await serve(undefined, undefined, history(), false, DOCUMENTED),
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
      description: "a windowed answer adopts its window, scoped",
      served: "windowed",
      policy: { adoptUnvouched: true },
    },
    {
      description: "a vouched answer adopts what the certificate signs, not the manifest's at",
      served: "certified",
      policy: { adoptUnvouched: false },
      trust: true,
    },
    {
      description:
        "a certificate over a row whose cells were first written out of column order vouches",
      served: "unsorted",
      policy: { adoptUnvouched: false },
      trust: true,
    },
    {
      description:
        "a page whose cells arrive out of column order, from a holder before U34, still vouches",
      served: "legacy",
      policy: { adoptUnvouched: false },
      trust: true,
    },
    {
      description: "a version 1 certificate is refused, and vouches for nothing",
      served: "stale",
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
    // what the `unsorted` holder folded: a port's holder of these serves `unsorted` (U34)
    unsortedEvents: unsortedHistory(),
    // what the `local` holder runs, and the row it wrote to its `local` table (U36)
    localSchema: portableSchema(SNAPSHOT_SCHEMA),
    draft: DRAFT,
    served,
    joins,
  };
}

if (import.meta.main) {
  const out = new URL("../snapshot-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(await snapshotVectors(), null, 2)}\n`);
}
