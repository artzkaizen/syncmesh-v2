import type { PostgresListener } from "@syncmesh/relay";

import { SQL } from "bun";

/** The listener the fanout wants, plus the one call that hangs the connection up. */
export interface FanoutConnection extends PostgresListener {
  readonly close: () => Promise<void>;
}

/**
 * Bun's Postgres client adapted to the fan-out port.
 *
 * **A dedicated listening connection, and that is the load-bearing detail.** `LISTEN` is
 * *session* state, so the subscription has to live on a connection somebody reads
 * notifications from: `sql.listen` opens one for itself and delivers each payload to the
 * callback. `NOTIFY` goes over the ordinary pool.
 *
 * The payload is base64 text because a notification is text. A relay frame is signed bytes, and
 * a round trip through UTF-8 would mangle every frame that is not valid UTF-8 — nearly all of
 * them — and the corruption would look like a fanout that silently drops traffic.
 */
export async function fanoutConnection(url: string): Promise<FanoutConnection> {
  const sql = new SQL({ url });
  return {
    // Bun's own subscription: a dedicated connection it opens on the first `listen`, re-subscribes
    // after a drop, and quotes the channel for. A bare `LISTEN` statement on a pooled client
    // subscribes a session whose notifications nothing reads — which is what this did before
    // the fleet ran in CI (gaps U15), and why no frame ever crossed between instances.
    listen: async (channel, onPayload) => {
      const subscription = await sql.listen(channel, onPayload);
      return () => subscription.unlisten();
    },
    notify: async (channel, payload) => {
      await sql.notify(channel, payload);
    },
    close: () => sql.close(),
  };
}
