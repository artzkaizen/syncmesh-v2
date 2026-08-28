import type { Row, RowKey, TableName } from "../change.js";
import type { CellValue, ColumnName } from "../record.js";

import { parsePeerId } from "../peer-id.js";

/**
 * The test primitives every package needs, declared once.
 *
 * A brand cast and a peer id are not interesting enough to think about twice, which is exactly
 * why they were being rewritten wherever they were needed — `seed` alone had thirteen identical
 * copies across four packages. Shared through a subpath rather than a package, following
 * `@syncmesh/wire/wire-tests`: everything that needs these already depends on the kernel.
 *
 * **Only what is provably identical belongs here.** Two packages having a `fakeClock` does not
 * make it one thing: the kernel's is a clock *source* (`{ now, set }`) and the engine's is an
 * `HlcClock` that can be moved. Merging those because the names matched would have quietly
 * changed what half the suites were testing. Same for a fixture that encodes one package's
 * domain — a schema, an engine, a room — which stays where its meaning is.
 */

/** Thirty-two bytes an identity can be built from: distinct per `n`, and the same every run. */
export const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);

export const PEER_A = parsePeerId("a".repeat(64)).unwrap();
export const PEER_B = parsePeerId("b".repeat(64)).unwrap();
export const PEER_C = parsePeerId("c".repeat(64)).unwrap();

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures; the naming rules for every identifier below belong to the schema, and a fixture is not where they are enforced */
export const table = (name: string) => name as TableName;
export const key = (value: string) => value as RowKey;
export const column = (name: string) => name as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export const row = (values: Readonly<Record<string, CellValue>>): Row =>
  new Map(Object.entries(values).map(([name, value]) => [column(name), value]));
