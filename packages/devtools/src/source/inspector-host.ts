/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-shape-in-symbol-names -- the leader's end of the inspector port: a read name and its arguments arrive as `unknown`, and the name is the parse */

import type { MeshInspector } from "@syncmesh/browser";
import type { Mesh } from "@syncmesh/client";
import type { RecentEvents, Unsubscribe } from "@syncmesh/engine";
import type { PresenceMap } from "@syncmesh/schema";

import type { DevtoolsSource, SqlValue } from "../contract.js";
import type { Carried, Opened, SnapshotName, Snapshot } from "./inspect-wire.js";
import type { MeshSourceOptions } from "./mesh-source.js";

import {
  InspectRefused,
  SNAPSHOTS,
  SNAPSHOT_READERS,
  carry,
  plain,
  revive,
} from "./inspect-wire.js";
import { createMeshControls } from "./mesh-controls.js";
import { createMeshSource } from "./mesh-source.js";

/**
 * The origin's **one** inspector, in the thread that holds the engine.
 *
 * This is the whole answer to the cost question `research/devtools-contract.md` §4 asks. Four tabs
 * with the panel open are not four `createMeshSource`s: they are four windows onto this one, which
 * takes the same three engine subscriptions and the same single `onTelemetry` it would take on a
 * device with one window. **`timings()` in particular is a poll and never a stream** — the
 * inspector here feeds one `createInspector`, and a window asks for its aggregates the way §3 says
 * to. Serving the telemetry union to N tabs as a feed would multiply the hottest hook in the
 * system by the number of windows somebody happened to open, which is exactly the mistake that
 * document exists to prevent.
 *
 * **It is built lazily and released.** {@link MeshInspector.watch} is what opens the source, and
 * the last window letting go is what closes it — so an origin nobody is inspecting holds nothing,
 * and a tab that closes leaves no subscription behind. A read that arrives while nothing is open
 * is refused rather than quietly opening one, because a reader nobody is watching is a reader
 * whose answers nothing would repaint.
 *
 * The controls half is beside it and is **not** gated that way, because `createMeshControls` holds
 * no subscriptions at all: a header badge in any window can ask what is held for the cost of a
 * round trip, whether or not a panel is open anywhere.
 *
 * @example
 * // in the elected tab's dedicated worker
 * const host = serveMesh(app.mesh, { inspector: createInspectorHost(app.mesh) });
 */
export function createInspectorHost<PC extends PresenceMap>(
  mesh: Mesh<"sqlite", PC>,
  options: MeshSourceOptions = {},
): MeshInspector {
  // SAFETY: `createMeshSource` is written against `Mesh`, whose presence map defaults to the empty
  // one, and `Topics<PC>` is invariant — so a mesh that declares a topic is not assignable to a
  // mesh that declares none, however much more it can do. The readers here reach `presence` only
  // through `schema.presence`, which is topic *names*, so widening it away is sound. The cast is
  // here rather than in every app that opens an inspector, which is where it used to be.
  const readable = mesh as Mesh;
  const controls = createMeshControls(readable);
  const watchers = new Set<(moved: unknown) => void>();
  let held: DevtoolsSource | undefined;
  let release: Unsubscribe | undefined;

  const watch = (listener: (moved: unknown) => void): Unsubscribe => {
    watchers.add(listener);
    if (held === undefined) {
      const source = createMeshSource(readable, options);
      held = source;
      release = source.onChange((moved) => {
        const channels = [...moved];
        for (const watcher of watchers) watcher(channels);
      });
    }
    return () => {
      if (!watchers.delete(listener) || watchers.size > 0) return;
      release?.();
      release = undefined;
      held?.close();
      held = undefined;
    };
  };

  const open = (read: string): DevtoolsSource => {
    if (held === undefined)
      throw new InspectRefused({
        read,
        message: "no window has the inspector open, so this mesh is not being read",
      });
    return held;
  };

  const snapshotOf = (source: DevtoolsSource, names: readonly SnapshotName[]): Snapshot => {
    const taken: Record<string, unknown> = {};
    for (const name of names) taken[name] = plain(SNAPSHOT_READERS[name](source));
    return taken;
  };

  const absent = (read: string, what: string): never => {
    throw new InspectRefused({ read, message: what });
  };

  /** The async half: each answers a `Result`, and each crosses as {@link Carried}. */
  const asked = async (read: string, args: readonly unknown[]): Promise<Carried> => {
    const source = open(read);
    // SAFETY: each argument is what the window's own typed reader took before it was posted
    const [first, second] = args as [unknown, unknown];
    if (read === "events")
      return carry(await source.events(revive(first) as RecentEvents | undefined));
    if (read === "storage")
      return source.storage === undefined
        ? absent(read, "this mesh has no SQL door, so its storage cannot be counted")
        : carry(await source.storage());
    if (read === "writes")
      return source.writes === undefined
        ? absent(read, "this mesh keeps no write ledger")
        : carry(await source.writes(first as number));
    // required on the contract, so there is no `absent` arm: a mesh that could not answer this
    // would be indistinguishable from one with nothing stranded
    if (read === "stranded") return carry(await source.stranded());
    return source.sql === undefined
      ? absent(read, "this mesh has no SQL door")
      : carry(await source.sql.query(first as string, (second ?? undefined) as SqlValue[]));
  };

  /** The prime: which optional members this mesh has, and one reading of every cached surface. */
  const opened = (source: DevtoolsSource): Opened => ({
    served: {
      storage: source.storage !== undefined,
      writes: source.writes !== undefined,
      sql: source.sql !== undefined,
    },
    snapshot: snapshotOf(source, SNAPSHOTS),
  });

  const ASYNC = new Set(["events", "storage", "writes", "stranded", "sql"]);

  const read = async (name: string, args: readonly unknown[]): Promise<unknown> => {
    // the controls half answers whether or not a panel is open: it subscribes to nothing, and a
    // header badge in a window with no panel is the case it exists for
    if (name === "forced") return plain(controls.forced());
    if (name === "force")
      // SAFETY: the window's own `force` took the name and the condition before posting them
      return carry(await controls.force(args[0] as string, args[1] as never));
    if (name === "release") return carry(await controls.release(args[0] as string));
    if (name === "open") return opened(open(name));
    // SAFETY: a window asks for a subset of the names it read off `SNAPSHOTS` in this same package
    if (name === "snapshot") return snapshotOf(open(name), args[0] as SnapshotName[]);
    if (ASYNC.has(name)) return asked(name, args);
    throw new InspectRefused({ read: name, message: `this inspector has no read called ${name}` });
  };

  return {
    read,
    watch,
    onForced: (listener) => controls.onChange(() => listener(plain(controls.forced()))),
  };
}
