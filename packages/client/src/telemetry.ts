import type { Engine, TelemetryEvent, Unsubscribe } from "@syncmesh/engine";
import type { Transport, TransportContext } from "@syncmesh/transport";

import { createHub, timed } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";

/**
 * What one listener on the mesh's seam sees: the engine's own events and the mesh's, as the one
 * union D17 decided on. The engine's are re-emitted rather than left on a second sink, so an app
 * that wants to know how its data moves subscribes once — the shape automerge-repo arrived at
 * when each of its subsystems had grown a listener of its own.
 */
export type MeshTelemetry = Extract<
  TelemetryEvent,
  { readonly type: `engine.${string}` | `mesh.${string}` }
>;

/** Only the engine's half; what {@link MeshTelemetrySeam.follow} re-emits. */
type EngineHalf = Extract<TelemetryEvent, { readonly type: `engine.${string}` }>;

const fromEngine = (event: TelemetryEvent): event is EngineHalf => event.type.startsWith("engine.");

/**
 * The mesh's telemetry, attached from outside the mesh: {@link MeshTelemetrySeam.observe} wraps
 * the transports on their way in, {@link MeshTelemetrySeam.follow} re-emits the engine's on the
 * way out, and both arrive at one listener.
 *
 * It attaches from outside rather than living on `Mesh` because `mesh.ts` is at its line cap.
 * `mesh.onTelemetry` is the shape this should eventually take; everything but that one property
 * is here.
 */
export interface MeshTelemetrySeam {
  /**
   * One listener for both layers. It runs after the work it describes, nothing waits on it, and
   * one that throws is contained here — telemetry never decides whether a write lands.
   */
  readonly onTelemetry: (listener: (event: MeshTelemetry) => void) => Unsubscribe;
  /**
   * Wraps the transports on their way into `createMesh`, which is where the mesh's own costs
   * are: starting a medium, waiting out its first pass, pushing bytes down it. The wrappers are
   * transparent — same promises, same rejections, the same optional capabilities present or
   * absent, the same `priority` — so nearest-first settling (RFC-0019) is unchanged.
   */
  readonly observe: (transports: readonly Transport[]) => readonly Transport[];
  /** Re-emits `engine.*` through this seam. Call it once the mesh is open, with `mesh.engine`. */
  readonly follow: (engine: Pick<Engine, "onTelemetry">) => Unsubscribe;
}

/**
 * One pass over several transports, measured whole. Reporting per transport would answer "how
 * long did the relay take" when the question an app is holding is "how long until I can stop
 * showing a spinner" — which is the last of them, not any one of them.
 */
function pass(total: number, done: (duration: Temporal.Duration) => void) {
  let started: Temporal.Instant | undefined;
  let finished = 0;
  return {
    enter: () => void (started ??= Temporal.Now.instant()),
    leave: () => {
      finished += 1;
      if (finished < total || started === undefined) return;
      const duration = started.until(Temporal.Now.instant());
      started = undefined;
      finished = 0;
      done(duration);
    },
  };
}

type Pass = ReturnType<typeof pass>;

/** The passes one `observe` call shares across the transports it wrapped. */
interface Observing {
  readonly emit: (event: MeshTelemetry) => void;
  readonly starts: Pass;
  readonly settles: Pass;
  readonly sends: Pass;
  /** Every leg of one presence pass carries the same wire; the size is written once per leg. */
  presenceBytes: number;
}

/**
 * One transport, reporting what it costs.
 *
 * Everything is copied across first and only the measured members are replaced, so a capability
 * this file has never heard of still reaches the mesh: `Transport` grows, and a wrapper that
 * listed the members it knew would quietly drop each new one — the same silent gap D17 rejected
 * a string-keyed map for. Presence and absence are then preserved member by member, because
 * `withBlobs()` reads `putBlob !== undefined` and settling reads `caughtUp` the same way: a
 * wrapper that filled either in would change what the mesh does, not just what it reports.
 */
function wrap(transport: Transport, watch: Observing): Transport {
  const observed: Transport = {
    ...transport,
    start: async (ctx: TransportContext) => {
      watch.starts.enter();
      try {
        await transport.start(ctx);
      } finally {
        watch.starts.leave();
      }
    },
  };
  const add = (member: Partial<Transport>): void => void Object.assign(observed, member);
  if (transport.caughtUp !== undefined)
    add({
      caughtUp: async () => {
        watch.settles.enter();
        try {
          await transport.caughtUp?.();
        } finally {
          watch.settles.leave();
        }
      },
    });
  if (transport.sendPresence !== undefined)
    add({
      sendPresence: (wire) => {
        watch.presenceBytes = wire.length;
        watch.sends.enter();
        try {
          transport.sendPresence?.(wire);
        } finally {
          watch.sends.leave();
        }
      },
    });
  if (transport.putBlob !== undefined)
    add({
      putBlob: async (hash, bytes) => {
        const [, duration] = await timed(async () => transport.putBlob?.(hash, bytes));
        watch.emit({ type: "mesh.blob.put", sizes: { bytes: bytes.length }, duration });
      },
    });
  if (transport.fetchBlob !== undefined)
    add({
      fetchBlob: async (hash, timeoutMs) => {
        const [answer, duration] = await timed(async () => transport.fetchBlob?.(hash, timeoutMs));
        watch.emit({ type: "mesh.blob.fetch", sizes: { bytes: answer?.length ?? 0 }, duration });
        return answer;
      },
    });
  return observed;
}

export function createMeshTelemetry(): MeshTelemetrySeam {
  const hub = createHub<MeshTelemetry>();

  const observe = (transports: readonly Transport[]): readonly Transport[] => {
    const settling = transports.filter((t) => t.caughtUp !== undefined).length;
    const sending = transports.filter((t) => t.sendPresence !== undefined).length;
    const watch: Observing = {
      emit: hub.emit,
      presenceBytes: 0,
      starts: pass(transports.length, (duration) =>
        hub.emit({
          type: "mesh.transports.start",
          sizes: { transports: transports.length },
          duration,
        }),
      ),
      settles: pass(settling, (duration) =>
        hub.emit({
          type: "mesh.transports.settled",
          sizes: { transports: settling },
          duration,
        }),
      ),
      sends: pass(sending, (duration) =>
        hub.emit({
          type: "mesh.presence.send",
          sizes: { bytes: watch.presenceBytes, transports: sending },
          duration,
        }),
      ),
    };
    return transports.map((transport) => wrap(transport, watch));
  };

  return {
    onTelemetry: hub.subscribe,
    observe,
    follow: (engine) =>
      engine.onTelemetry((event) => {
        if (fromEngine(event)) hub.emit(event);
      }),
  };
}

/**
 * The mesh's seam over one open engine: `engine.*` re-emitted here, so an app wires one listener
 * rather than one per layer (D17). The relay's half of the union is not carried yet — its
 * variants would name peers, and D17 left that a privacy question rather than a design one.
 */
export function followTelemetry(
  engine: Pick<Engine, "onTelemetry">,
): MeshTelemetrySeam["onTelemetry"] {
  const seam = createMeshTelemetry();
  seam.follow(engine);
  return seam.onTelemetry;
}
