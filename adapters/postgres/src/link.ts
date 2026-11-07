import type { ChangeMessage, ChangeStream, Watermark } from "@syncmesh/cdc";

import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { AckLedger } from "./acks.js";
import type { Lsn } from "./lsn.js";
import type { PostgresSourceError } from "./replication-errors.js";
import type { PostgresChangeSourceOptions } from "./replication.js";
import type { DecodeSession } from "./session.js";
import type { SlotStatus } from "./slot.js";

import { createAckLedger } from "./acks.js";
import { lsnText, parseLsnWatermark } from "./lsn.js";
import { decodePgOutput, parseServerFrame, standbyStatus } from "./pgoutput.js";
import { ReplicationFailed, SlotBusy } from "./replication-errors.js";
import { createDecodeSession } from "./session.js";
import { isObjectInUse } from "./slot.js";

const HIGH_WATER = 512;
const LOW_WATER = 128;
/** Seconds a stopping connection gets to finish its CopyDone handshake before it is cut. */
const GRACE = 2;

const milliseconds = (duration: Temporal.Duration) => duration.total("milliseconds");

/**
 * The copy-both stream postgres.js's `.writable()` resolves to. It is a Node duplex at runtime
 * though typed as a writable, so the flow control a duplex adds is optional here; without it a
 * slow consumer buffers instead of pushing back.
 */
export interface ReplicationStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "error", listener: (cause: Error) => void): void;
  on(event: "close", listener: () => void): void;
  write(chunk: Uint8Array): void;
  end(): void;
  pause?(): void;
  resume?(): void;
}

/**
 * A postgres.js client opened in replication mode. Structural, like {@link PostgresQuerier}:
 *
 * ```ts
 * const connect = () =>
 *   postgres(url, {
 *     max: 1,
 *     fetch_types: false,
 *     max_lifetime: null,
 *     connection: { replication: "database" },
 *   })
 * ```
 */
export interface ReplicationClient {
  unsafe(query: string): { writable(): Promise<ReplicationStream> };
  /** postgres.js's own unit: seconds before open queries are abandoned. */
  end(options?: { timeout?: number }): Promise<void>;
}

export interface LinkDeps {
  readonly options: PostgresChangeSourceOptions;
  readonly start: Lsn;
  readonly primaryKey: (oid: number) => Promise<Result<string[], PostgresSourceError>>;
  readonly status: () => Promise<Result<SlotStatus | null, PostgresSourceError>>;
  /** Hands over a closing connection, so a drop or a restart can wait for it to finish. */
  readonly track: (closing: Promise<void>) => void;
}

/**
 * One stream's state: the connection (and its replacements), the frames received and not yet
 * decoded, the positions delivered and not yet acked, and the decoder's per-session relations.
 */
export class Link {
  private client: ReplicationClient | undefined;
  private socket: ReplicationStream | undefined;
  private frames: Uint8Array[] = [];
  private waiting: (() => void) | undefined;
  private failure: PostgresSourceError | undefined;
  private stopped = false;
  private paused = false;
  private attempts = 0;
  private readonly acks: AckLedger;
  private readonly session: DecodeSession;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly deps: LinkDeps) {
    this.acks = createAckLedger(deps.start);
    this.session = createDecodeSession({
      start: deps.start,
      acks: this.acks,
      primaryKey: deps.primaryKey,
    });
  }

  private get slot() {
    return this.deps.options.slot;
  }

  /** Connects, retrying as `reconnect` allows; the first failure that exhausts it is the value. */
  async open(): Promise<Result<void, PostgresSourceError>> {
    const policy = this.deps.options.reconnect ?? {
      attempts: 5,
      delay: Temporal.Duration.from({ seconds: 1 }),
    };
    for (;;) {
      const connected = await this.connect();
      if (connected.isOk()) {
        // a reconnect that lands after stop() must not leave timers reading the slot
        if (!this.stopped) this.startTimers();
        return connected;
      }
      this.attempts += 1;
      if (this.attempts > policy.attempts || this.stopped) return connected;
      await new Promise((resolve) => setTimeout(resolve, milliseconds(policy.delay)));
    }
  }

  private async connect(): Promise<Result<void, PostgresSourceError>> {
    const { options } = this.deps;
    const client = options.connect();
    const command =
      `START_REPLICATION SLOT ${options.slot} LOGICAL ${lsnText(this.session.cursor())} ` +
      `(proto_version '1', publication_names '${options.publication}')`;
    const opened = await Result.tryPromise({
      try: () => client.unsafe(command).writable(),
      catch: (cause) =>
        isObjectInUse(cause)
          ? new SlotBusy({ slot: this.slot, message: `${this.slot} is read elsewhere`, cause })
          : new ReplicationFailed({ slot: this.slot, message: `${this.slot}: ${command}`, cause }),
    });
    if (opened.isErr()) {
      this.deps.track(client.end({ timeout: 0 }).catch(() => undefined));
      return Result.err(opened.error);
    }
    const socket = opened.value;
    if (this.stopped) {
      socket.end();
      this.deps.track(client.end({ timeout: GRACE }).catch(() => undefined));
      return Result.ok(undefined);
    }
    this.client = client;
    this.socket = socket;
    socket.on("data", (chunk) => {
      if (socket !== this.socket) return;
      this.frames.push(chunk);
      if (!this.paused && this.frames.length > HIGH_WATER) {
        this.paused = true;
        socket.pause?.();
      }
      this.wake();
    });
    socket.on("error", () => this.dropped(socket));
    socket.on("close", () => this.dropped(socket));
    return Result.ok(undefined);
  }

  /**
   * The connection went away underneath us. Frames not yet decoded are discarded — Postgres
   * sends them again from `cursor` — and a transaction open in the decoder is abandoned, which
   * the `begin` of its resend tells the bridge.
   */
  private dropped(socket: ReplicationStream) {
    if (socket !== this.socket || this.stopped) return;
    this.socket = undefined;
    this.frames = [];
    this.paused = false;
    this.session.abandon();
    const client = this.client;
    this.client = undefined;
    // the server already closed it; a graceful end would wait on a query that cannot finish
    if (client !== undefined) this.deps.track(client.end({ timeout: 0 }).catch(() => undefined));
    void this.open().then((reopened) => {
      if (reopened.isErr() && !this.stopped) {
        this.failure = new ReplicationFailed({
          slot: this.slot,
          message: `${this.slot}: the connection dropped and would not come back`,
          cause: reopened.error,
        });
        this.wake();
      }
    });
  }

  private wake() {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }

  private startTimers() {
    if (this.timers.length > 0) return;
    const { options } = this.deps;
    const every = options.status ?? Temporal.Duration.from({ seconds: 10 });
    this.every(every, () => this.report());
    const lag = options.lag;
    if (lag !== undefined) {
      const period = lag.every ?? Temporal.Duration.from({ seconds: 30 });
      this.every(period, () => {
        void this.deps.status().then((read) => {
          // a slot that cannot be read raises nothing here; the stream itself fails on it
          const found = read.unwrapOr(null);
          if (found !== null && (found.lag > lag.bytes || found.wal === "unreserved")) {
            lag.alarm(found);
          }
        });
      });
    }
  }

  /** A timer that never holds a process open by itself: the connection does that. */
  private every(period: Temporal.Duration, tick: () => void) {
    const timer = setInterval(tick, milliseconds(period));
    timer.unref();
    this.timers.push(timer);
  }

  /** The standby status update: the only frame that moves the slot. */
  private report() {
    const socket = this.socket;
    if (socket === undefined) return;
    socket.write(standbyStatus(this.acks.confirmed(), Temporal.Now.instant()));
  }

  private async next(): Promise<Uint8Array | undefined> {
    for (;;) {
      // frames buffered past a stop are dropped: what they held is resent on the next start
      if (this.stopped) return undefined;
      const frame = this.frames.shift();
      if (frame !== undefined) {
        if (this.paused && this.frames.length < LOW_WATER) {
          this.paused = false;
          this.socket?.resume?.();
        }
        return frame;
      }
      if (this.failure !== undefined) throw this.failure;
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }

  ack(watermark: Watermark) {
    const parsed = parseLsnWatermark(watermark);
    // not a position this source delivered, so it releases nothing
    if (parsed.isOk() && this.acks.ack(parsed.value)) this.report();
  }

  /** A keepalive: the server has sent everything before `end`. */
  private keepalive(end: Lsn, reply: boolean) {
    if (!this.session.inTransaction()) this.acks.idle(end);
    if (reply) this.report();
  }

  stream(): ChangeStream {
    return {
      changes: this.changes(),
      ack: (watermark) => this.ack(watermark),
      stop: () => this.stop(),
    };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.report();
    const socket = this.socket;
    const client = this.client;
    this.socket = undefined;
    this.client = undefined;
    // a write or end on a stream that already failed reports through its error event, never a throw
    if (socket !== undefined) socket.end();
    if (client !== undefined)
      this.deps.track(client.end({ timeout: GRACE }).catch(() => undefined));
    this.wake();
  }

  private async *changes(): AsyncGenerator<ChangeMessage> {
    try {
      for (;;) {
        const frame = await this.next();
        if (frame === undefined) return;
        this.attempts = 0;
        const parsed = parseServerFrame(frame);
        if (parsed.isErr()) throw parsed.error;
        const server = parsed.value;
        if (server.t === "keepalive") {
          this.keepalive(server.end, server.reply);
          continue;
        }
        const decoded = decodePgOutput(server.payload);
        if (decoded.isErr()) throw decoded.error;
        const translated = await this.session.translate(decoded.value);
        if (translated.isErr()) throw translated.error;
        yield* translated.value;
      }
    } finally {
      this.stop();
    }
  }
}
