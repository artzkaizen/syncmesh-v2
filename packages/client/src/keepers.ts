import type { LinkEvent, Transport, TransportContext } from "@syncmesh/transport";

import type { AdmissionFacts } from "./admission.js";
import type { MeshShaping } from "./transports.js";

import { createChurn } from "./churn.js";
import { watchStaleLinks } from "./stale.js";

/**
 * What keeps a room from settling wrong, both on timers of their own: churn — the other half of
 * island prevention (book ch. 17), which acts only on a medium at its budget so a small room pays
 * nothing for it — and the stale watch (E28), off unless the app names a window. One stop for both.
 */
export function startKeepers(
  shaping: MeshShaping,
  transports: () => readonly Transport[],
  facts: () => AdmissionFacts,
  context: TransportContext,
  report: (event: LinkEvent) => void,
): () => void {
  const churn =
    shaping.churn === false
      ? undefined
      : createChurn(transports, facts, shaping.churn === undefined ? {} : shaping.churn);
  const stale =
    shaping.stale === undefined
      ? undefined
      : watchStaleLinks(transports, context, report, shaping.stale);
  return () => {
    churn?.stop();
    stale?.stop();
  };
}
