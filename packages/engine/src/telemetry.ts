import { Temporal } from "@syncmesh/temporal";

/**
 * What the engine reports about itself: the two paths a write takes through it.
 */
export type EngineTelemetry =
  | {
      readonly type: "engine.mutate";
      readonly sizes: { readonly changes: number };
      readonly duration: Temporal.Duration;
    }
  | {
      readonly type: "engine.fold";
      readonly sizes: { readonly events: number; readonly keys: number };
      readonly duration: Temporal.Duration;
    };

/**
 * What the top object reports about the links it runs. The mesh's own work is transport work —
 * starting a medium, waiting for its first pass, pushing bytes through it — so these are the
 * costs an app cannot see from the engine alone: the engine is fast and the radio is not.
 */
export type MeshTelemetry =
  | {
      readonly type: "mesh.transports.start";
      readonly sizes: { readonly transports: number };
      readonly duration: Temporal.Duration;
    }
  | {
      /**
       * Every source that could still fill a scope has finished its first pass (RFC-0019) — the
       * wait an app puts a spinner in front of, and the one number that says whether it was
       * worth it.
       */
      readonly type: "mesh.transports.settled";
      readonly sizes: { readonly transports: number };
      readonly duration: Temporal.Duration;
    }
  | {
      readonly type: "mesh.presence.send";
      readonly sizes: { readonly bytes: number; readonly transports: number };
      readonly duration: Temporal.Duration;
    }
  | {
      readonly type: "mesh.blob.put";
      readonly sizes: { readonly bytes: number };
      readonly duration: Temporal.Duration;
    }
  | {
      /** `bytes: 0` is the honest report of a fetch nobody could answer, not a missing event. */
      readonly type: "mesh.blob.fetch";
      readonly sizes: { readonly bytes: number };
      readonly duration: Temporal.Duration;
    };

/**
 * What a room reports about the sockets it serves. Deliberately anonymous: no variant carries a
 * peer id, a room name or any part of a payload, because D17 left "may relay telemetry name
 * peers" open as a privacy question and an emitted identity cannot be taken back out of whatever
 * collected it. Counts and byte totals answer "how big, how long" without answering "who".
 */
export type RelayTelemetry =
  | {
      /** The handshake, measured whole: how much cursor state a joiner arrived holding. */
      readonly type: "relay.join";
      readonly sizes: { readonly cursors: number; readonly presence: number };
      readonly duration: Temporal.Duration;
    }
  | {
      /** The paged catch-up: what the log held, what survived interest and admission, in how many frames. */
      readonly type: "relay.catchup";
      readonly sizes: {
        readonly found: number;
        readonly admitted: number;
        /**
         * **Admitted entries the relay could not build an envelope for, and so did not send.**
         *
         * Zero on every healthy room, and the one number here that is a fault rather than a
         * measurement. An entry with no signature beside it can never be forwarded — nobody but
         * its author can sign it — so a joiner is handed a run with a hole in it, and the
         * joiner has no way at all to notice: `admitted` counts what passed interest, `pages`
         * counts frames, and neither moves when an event is dropped on the way into one.
         *
         * It is reported rather than refused because refusing would take the rest of the history
         * away from a joiner that can still use it. Counted rather than named, because every
         * `relay.*` variant is anonymous by construction (D17) and an event id is a peer id with
         * a number after it. A non-zero reading is the signal; which events is a question for
         * the device that holds them, where `Engine.stranded` names them.
         */
        readonly unsendable: number;
        readonly pages: number;
      };
      readonly duration: Temporal.Duration;
    }
  | {
      /** One event verified, appended and fanned out; `receivers` counts sockets, never names them. */
      readonly type: "relay.event";
      readonly sizes: { readonly bytes: number; readonly receivers: number };
      readonly duration: Temporal.Duration;
    }
  | {
      readonly type: "relay.blob.put";
      readonly sizes: { readonly bytes: number };
      readonly duration: Temporal.Duration;
    }
  | {
      /** `bytes: 0` is a `blob-missing` answer — the room does not hold them. */
      readonly type: "relay.blob.get";
      readonly sizes: { readonly bytes: number };
      readonly duration: Temporal.Duration;
    }
  | {
      /**
       * A room opened keeping its log forever (gap audit №8).
       *
       * Not a warning and not a default anyone changed for you: a room that keeps everything is
       * the only kind a **new** device can bootstrap from history alone, so trimming is a real
       * decision about what the room *is* and not a disk setting. What this does is make the
       * decision visible — an operator reading telemetry learns which of their rooms grow
       * forever, rather than learning it from a disk alert.
       *
       * `sizes.blobBytes` is the blob ceiling that *is* in force; blobs are content-addressed,
       * so dropping them costs nothing that cannot be put back, and they default to a ceiling.
       */
      readonly type: "relay.retention.unbounded";
      readonly sizes: { readonly blobBytes: number };
      readonly duration: Temporal.Duration;
    };

/**
 * One event from one layer, discriminated by a `type` whose prefix names the layer that emitted
 * it (D17). It is a single union rather than one per package so a consumer writes one `switch`
 * and the compiler tells it about a variant nobody handled yet; under a string-keyed map that
 * same gap compiles, ships, and shows up months later as a panel that was always blank.
 *
 * Every variant carries `sizes` and `duration`, so the two questions worth asking of a running
 * mesh — how big was it, how long did it take — can be read off any event without narrowing to
 * a variant first. A layer only ever emits its own prefix; the seams are typed over the whole
 * union so one listener can be handed to all three.
 */
export type TelemetryEvent = EngineTelemetry | MeshTelemetry | RelayTelemetry;

export type TelemetryListener = (event: TelemetryEvent) => void;

/**
 * Runs `block` and reports how long it took. An async block is measured to its settlement, not
 * to the return of its first synchronous half — the store call is the part worth timing, and
 * timing only the call that started it reports every append as instantaneous.
 */
export function timed<T>(block: () => Promise<T>): Promise<readonly [T, Temporal.Duration]>;
export function timed<T>(block: () => T): readonly [T, Temporal.Duration];
export function timed<T>(
  block: () => T | Promise<T>,
): readonly [T, Temporal.Duration] | Promise<readonly [T, Temporal.Duration]> {
  const start = Temporal.Now.instant();
  const since = (): Temporal.Duration => start.until(Temporal.Now.instant());
  const value = block();
  return value instanceof Promise ? value.then((settled) => [settled, since()]) : [value, since()];
}
