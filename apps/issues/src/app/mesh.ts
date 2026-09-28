import { syncmeshReact } from "@syncmesh/react";

import { openClient } from "./replica.js";

/**
 * The client, bound once, for every screen in this app.
 *
 * `mesh.api` is the procedures over whichever link this tab holds — `mesh.api.issues.list(…)` —
 * and `mesh.useStatus()` and its four siblings are the device's facts as React state, pushed to
 * this window by the worker that holds the engine. A property for the thing that never changes,
 * a hook for each thing that does.
 *
 * The promise settles the first time a link is held and never rejects: a tab told there is no
 * rendezvous can be promoted a minute later, so a refused open is drawn from `replicaState`
 * under `whileOpening` rather than handed to the factory, whose failure is final.
 */
export const mesh = syncmeshReact(openClient());
