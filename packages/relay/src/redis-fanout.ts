import type { Fanout, FanoutLink } from "./fanout.js";

/**
 * The publishing half of a Redis client: `publish` as node-redis v4 exposes it. ioredis fits
 * with a two-line wrapper. Structural on purpose — no dependency on either package.
 */
export interface RedisPublisher {
  /** Resolves with how many subscribers Redis reached — unused here, best-effort by design. */
  readonly publish: (channel: string, message: Uint8Array) => Promise<number>;
}

/** The subscribing half — in Redis a connection in subscriber mode, so it is a second client. */
export interface RedisSubscriber {
  readonly subscribe: (channel: string, listener: (message: Uint8Array) => void) => Promise<void>;
  readonly unsubscribe: (
    channel: string,
    listener?: (message: Uint8Array) => void,
  ) => Promise<void>;
}

export interface RedisFanoutOptions {
  readonly publisher: RedisPublisher;
  readonly subscriber: RedisSubscriber;
  /** Channel prefix, so one Redis serves several meshes. Default `syncmesh`. */
  readonly prefix?: string;
}

/** Each link's frames carry its own random tag, and the link drops what bears it: Redis echoes to every subscriber, the fanout contract does not. */
const TAG_BYTES = 16;

/**
 * D09-B's port over Redis pub/sub: several relay instances serving one room, best-effort by
 * design — a message Redis drops is recovered by the next cursor catch-up, so correctness never
 * depends on it. Publishes and subscriptions are fire-and-forget; a rejected call is swallowed
 * for the same reason.
 */
export function redisFanout(options: RedisFanoutOptions): Fanout {
  const { publisher, subscriber } = options;
  const prefix = options.prefix ?? "syncmesh";
  return {
    connect: (room): FanoutLink => {
      const channel = `${prefix}:${room}`;
      const tag = crypto.getRandomValues(new Uint8Array(TAG_BYTES));
      const listeners = new Set<(frame: Uint8Array) => void>();
      const deliver = (message: Uint8Array): void => {
        if (message.length < TAG_BYTES) return;
        if (tag.every((byte, i) => message[i] === byte)) return; // our own publish, echoed back
        const frame = message.subarray(TAG_BYTES);
        for (const listener of listeners) listener(frame);
      };
      let subscribed = false;
      return {
        publish: (frame) => {
          const tagged = new Uint8Array(TAG_BYTES + frame.length);
          tagged.set(tag, 0);
          tagged.set(frame, TAG_BYTES);
          void publisher.publish(channel, tagged).catch(() => undefined);
        },
        onFrame: (listener) => {
          listeners.add(listener);
          if (!subscribed) {
            subscribed = true;
            void subscriber.subscribe(channel, deliver).catch(() => undefined);
          }
          return () => void listeners.delete(listener);
        },
        close: () => {
          listeners.clear();
          if (subscribed) void subscriber.unsubscribe(channel, deliver).catch(() => undefined);
        },
      };
    },
  };
}
