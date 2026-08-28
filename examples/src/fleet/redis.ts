import type { RedisPublisher, RedisSubscriber } from "@syncmesh/relay";

import { createClient } from "redis";

/** The two halves `redisFanout` wants, plus the one call that hangs both connections up. */
export interface RedisPubSub {
  readonly publisher: RedisPublisher;
  readonly subscriber: RedisSubscriber;
  readonly close: () => Promise<void>;
}

/**
 * node-redis adapted to the fan-out port. Two connections, not one: Redis puts a subscribed
 * connection into subscriber mode, where it will not take a `PUBLISH`.
 *
 * `bufferMode` is the load-bearing argument. A relay frame is signed bytes, and node-redis
 * decodes a message as UTF-8 unless told otherwise — a round trip through a string would
 * mangle every frame that is not valid UTF-8, which is nearly all of them, and the corruption
 * would look like a fan-out that silently drops traffic.
 */
export async function redisPubSub(url: string): Promise<RedisPubSub> {
  const publisher = await createClient({ url }).connect();
  const subscriber = await createClient({ url }).connect();
  return {
    publisher: {
      publish: (channel, message) => publisher.publish(channel, Buffer.from(message)),
    },
    subscriber: {
      subscribe: (channel, listener) => subscriber.subscribe(channel, listener, true),
      unsubscribe: (channel, listener) => subscriber.unsubscribe(channel, listener, true),
    },
    close: async () => {
      await subscriber.close();
      await publisher.close();
    },
  };
}
