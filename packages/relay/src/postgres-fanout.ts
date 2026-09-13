import type { Fanout, FanoutLink } from "./fanout.js";

/**
 * D09-B's port over Postgres `LISTEN`/`NOTIFY` (book ch. 21, rung 2).
 *
 * **Postgres instead of Redis because the relay already has one.** A fleet that terminates
 * WebSockets in several processes over one database needed a second piece of infrastructure for
 * nothing but a cross-process wake, and a second piece of infrastructure is a second thing to
 * run, monitor and lose. What `NOTIFY` adds over a pub/sub service is that **delivery is
 * transactional**: a rollback sends nothing, and identical notifications inside one transaction
 * collapse, so a five-hundred-event fold wakes each listener once.
 *
 * **`LISTEN` is session state, so the connection must be a dedicated one** — direct to Postgres,
 * never through a transaction pooler, which hands a different backend to every statement and
 * would leave the subscription on whichever one happened to run it.
 *
 * Structural on purpose: the two calls, and no dependency on postgres.js, pg or anything else.
 */

export interface PostgresListener {
  /** Subscribes the session to `channel`; resolves with how to stop listening. */
  readonly listen: (
    channel: string,
    onPayload: (payload: string) => void,
  ) => Promise<() => void | Promise<void>>;
  /** `pg_notify(channel, payload)`. Fire-and-forget, like the port it implements. */
  readonly notify: (channel: string, payload: string) => Promise<void>;
}

export interface PostgresFanoutOptions {
  readonly client: PostgresListener;
  /** Channel prefix, so one database serves several meshes. Default `syncmesh`. */
  readonly prefix?: string;
  /**
   * This instance had a frame too large for a notification, and sent a wake in its place.
   *
   * **Postgres caps a payload at 8000 bytes**, and a frame travels base64 — four bytes for every
   * three — so anything over about 5.9 kB cannot go this way. It is not split: a reassembly
   * protocol here would be a second delivery guarantee inside a transport whose whole contract
   * is that it has none, and a half-arrived frame is a failure mode with no owner.
   */
  readonly onOversize?: (bytes: number) => void;
  /**
   * **Another instance serving this room could not send something, and this instance is behind.**
   *
   * A wake carries no payload, which is the only shape that always fits. It does **not** recover
   * the frame and cannot: this port is `publish`/`onFrame`, so there is no channel to ask the
   * other instance on, and adding one would be a new port rather than a fallback. What the wake
   * buys is that the gap stops being **silent on the side that has it** — before this, only the
   * sender knew, through `onOversize`, and the instance actually missing the event had no idea.
   *
   * What still closes the gap is what closes any dropped frame: a device that holds the event
   * connecting to this instance and pushing everything above the cursors its `hello` advertised.
   * A fleet with sticky sockets and few devices should read this as an outage, not a rounding
   * error — and now it can, from the instance that is wrong rather than the one that is fine.
   */
  readonly onGap?: () => void;
}

/** Each link's payloads carry its own random tag, and the link drops what bears it: `NOTIFY` reaches the notifying session too, the fanout contract does not. */
const TAG_BYTES = 16;

/** What a notification is: a frame to ingest, or the admission that one would not fit. */
const FRAME = 0x01;
const WAKE = 0x00;
const HEADER = TAG_BYTES + 1;

/** What Postgres will carry in one notification, and what base64 leaves of it. */
const NOTIFY_LIMIT = 8000;
const MAX_FRAME = Math.floor(((NOTIFY_LIMIT - 1) * 3) / 4) - HEADER;

/**
 * A room as a channel name.
 *
 * Hashed rather than interpolated because a channel is an **identifier** to Postgres, not a
 * value: a room called `"; DROP` would be a room name everywhere else in this system and a
 * statement here. A collision costs two rooms one shared feed, and the tag below still keeps
 * each link off its own frames — the cursor exchange settles the rest.
 */
const channelFor = (room: string): string => {
  let hash = 7;
  for (const char of room) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash.toString(36);
};

const encode = (tag: Uint8Array, kind: number, frame: Uint8Array): string => {
  const tagged = new Uint8Array(HEADER + frame.length);
  tagged.set(tag, 0);
  tagged[TAG_BYTES] = kind;
  tagged.set(frame, HEADER);
  return btoa(String.fromCharCode(...tagged));
};

/** `undefined` for a payload that is not this channel's — corrupt, truncated, or somebody else's. */
const decode = (payload: string): Uint8Array | undefined => {
  try {
    const raw = atob(payload);
    if (raw.length < HEADER) return undefined;
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

export function postgresFanout(options: PostgresFanoutOptions): Fanout {
  const { client } = options;
  const prefix = options.prefix ?? "syncmesh";
  return {
    connect: (room): FanoutLink => {
      const channel = `${prefix}_${channelFor(room)}`;
      const tag = crypto.getRandomValues(new Uint8Array(TAG_BYTES));
      const listeners = new Set<(frame: Uint8Array) => void>();
      const deliver = (payload: string): void => {
        const tagged = decode(payload);
        if (tagged === undefined) return;
        if (tag.every((byte, index) => tagged[index] === byte)) return; // our own, echoed back
        if (tagged[TAG_BYTES] === WAKE) {
          options.onGap?.();
          return;
        }
        const frame = tagged.subarray(HEADER);
        for (const listener of listeners) listener(frame);
      };
      let stop: (() => void | Promise<void>) | undefined;
      let listening = false;
      return {
        publish: (frame) => {
          const oversize = frame.length > MAX_FRAME;
          if (oversize) options.onOversize?.(frame.length);
          // a wake in its place: the other instances learn they are behind, which is strictly
          // more than they knew when an oversize frame was simply not sent
          const payload = oversize
            ? encode(tag, WAKE, new Uint8Array(0))
            : encode(tag, FRAME, frame);
          void client.notify(channel, payload).catch(() => undefined);
        },
        onFrame: (listener) => {
          listeners.add(listener);
          if (!listening) {
            listening = true;
            void client
              .listen(channel, deliver)
              .then((off) => (stop = off))
              .catch(() => undefined);
          }
          return () => void listeners.delete(listener);
        },
        close: () => {
          listeners.clear();
          const off = stop;
          stop = undefined;
          listening = false;
          if (off !== undefined) void Promise.resolve(off()).catch(() => undefined);
        },
      };
    },
  };
}
