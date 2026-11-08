import type { PeerId } from "@syncmesh/kernel";
import type { ColumnsMap, Schema } from "@syncmesh/schema";
import type {
  Transport,
  TransportVisibility,
  VisibilityToken,
  Withheld,
} from "@syncmesh/transport";
import type { VisibilityLost, VisibilityTimeout } from "@syncmesh/transport";

import { Result } from "@syncmesh/result";
import { authorityTables } from "@syncmesh/schema";

import { NoSuchCapability } from "./errors.js";

/**
 * Reading back what was just written (RFC-0020 §3.2): a position in an ordered log, and a wait
 * to reach it. What a server hands a caller after a procedure — the token its own write landed
 * at — so the caller's device can wait for its own copy rather than polling a query.
 *
 * A capability of the medium, not of the mesh. A radio has no ordered log to name a position in,
 * so a mesh with none answers {@link NoSuchCapability} rather than pretending (D12).
 */
export interface MeshVisibility {
  /**
   * How far this device has been told the log runs, in the lineage it was told under;
   * `undefined` until a session has said.
   */
  readonly token: () => Result<VisibilityToken | undefined, NoSuchCapability>;
  /**
   * Settles once this device has folded everything up to the token's position, in the token's
   * lineage. `VisibilityLost` when that lineage is not the one being read — including when it
   * changes while waiting — and `VisibilityTimeout` when the deadline (default 10s) passes first.
   */
  readonly visibleAt: (
    token: VisibilityToken,
    options?: { readonly timeoutMs?: number },
  ) => Promise<Result<void, VisibilityLost | VisibilityTimeout | NoSuchCapability>>;
}

const none = () =>
  Result.err(
    new NoSuchCapability({
      capability: "visibility",
      message: "no transport here keeps an ordered log to name a position in",
    }),
  );

export function createMeshVisibility(transports: () => readonly Transport[]): MeshVisibility {
  const capable = (): readonly TransportVisibility[] =>
    transports().flatMap((t) => (t.visibility === undefined ? [] : [t.visibility]));
  return {
    token: () => {
      const all = capable();
      if (all.length === 0) return none();
      return Result.ok(all.map((v) => v.token()).find((t) => t !== undefined));
    },
    visibleAt: async (token, options) => {
      const all = capable();
      // the medium reading the token's own log, when one is; otherwise the first, whose answer is
      // the honest one: a lineage it is not reading is Lost, and one it has not heard yet is a wait
      const reading = all.find((v) => v.token()?.epoch === token.epoch) ?? all[0];
      if (reading === undefined) return none();
      return reading.visibleAt(token, options);
    },
  };
}

/**
 * What a peer-to-peer link withholds (D24): the authority-visibility tables, and the run they sit
 * in. Empty — and so absent — for a manifest that gates nothing, which is every manifest that
 * existed before the tier did.
 */
export const gatedFor = (
  schema: { readonly entries: Schema<ColumnsMap>["entries"] },
  authority: PeerId | undefined,
): { readonly withheld?: Withheld } => {
  const tables = authorityTables(schema);
  return tables.length === 0 ? {} : { withheld: { tables: new Set(tables), author: authority } };
};
