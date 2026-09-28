import type { PostgresListener } from "@syncmesh/relay";

import { SQL } from "bun";

/** The listener the fanout wants, plus the one call that hangs the connection up. */
export interface FanoutConnection extends PostgresListener {
  readonly close: () => Promise<void>;
}

/**
 * Bun's Postgres client adapted to the fan-out port.
 *
 * **One dedicated connection, and that is the load-bearing detail.** `LISTEN` is *session*
 * state: a pooled client hands a different backend to every statement, so the subscription
 * would live on whichever one happened to run it and the next `NOTIFY` would arrive at a
 * session nobody is reading. `max: 1` with no idle timeout is the whole configuration.
 *
 * The payload is base64 text because a notification is text. A relay frame is signed bytes, and
 * a round trip through UTF-8 would mangle every frame that is not valid UTF-8 — nearly all of
 * them — and the corruption would look like a fanout that silently drops traffic.
 */
export async function fanoutConnection(url: string): Promise<FanoutConnection> {
  const sql = new SQL({ url, max: 1, idleTimeout: 0 });
  const notifiers = new Map<string, (payload: string) => void>();
  return {
    listen: async (channel, onPayload) => {
      // the channel name is this module's own — hashed by `postgresFanout`, never a room string
      await sql.unsafe(`LISTEN "${channel}"`);
      const stream = sql.unsafe(`SELECT 1`); // keeps the one connection warm for the session
      void stream;
      notifiers.set(channel, onPayload);
      return async () => {
        notifiers.delete(channel);
        await sql.unsafe(`UNLISTEN "${channel}"`).catch(() => undefined);
      };
    },
    notify: async (channel, payload) => {
      await sql`SELECT pg_notify(${channel}, ${payload})`;
    },
    close: () => sql.close(),
  };
}
