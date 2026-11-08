import { wasmSqliteDriver } from "@syncmesh/sqlite-wasm";

import type { FollowerClient } from "../../client.js";

import { connectMesh } from "../../client.js";
import { openMeshLink } from "../../tabs.js";
import { notes, schema } from "./schema.js";

/**
 * One tab of the two-tab origin, driven by `two-tabs.test.ts` through `globalThis.tab`.
 *
 * Every read and write goes through `connectMesh`, so a tab holds no database of its own — the
 * origin's one is in whichever tab's worker won the election, and a tab that loses its link (that
 * tab closed) asks for a new one and carries on against the next.
 */
interface Connected {
  readonly role: "leader" | "follower";
  readonly client: FollowerClient<Record<never, never>>;
}

/** Every row count a live query over `notes` has shown in this tab, in order. */
const seen: number[] = [];
let current: Promise<Connected> | undefined;
let failure = "";

const connect = async (): Promise<Connected> => {
  const opened = await openMeshLink({
    worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  });
  if (opened.isErr()) {
    failure = `${opened.error._tag}: ${opened.error.message}`;
    throw opened.error;
  }
  const link = opened.value;
  const client = connectMesh({ link, schema, procedures: {} });
  // a link lost before it was ready leaves this call's `$ready` refused; the next one is current
  link.onLost(() => void (current = attempt()));
  await client.$ready;
  const handle = client.$mesh.on().unwrap();
  handle.live(handle.db.select().from(notes)).subscribe((rows) => seen.push(rows.length));
  return { role: link.role, client };
};

/** A connection the page asks through, observed so one refused mid-handover is not unhandled. */
const attempt = () => {
  const made = connect();
  made.catch(() => undefined);
  return made;
};

current = attempt();

/** The page's visibility, as the test sets it: headless pages are always shown otherwise. */
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
const turn = (next: DocumentVisibilityState) => {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
};

const mesh = async () => (await (current ?? attempt())).client.$mesh;

Object.assign(globalThis, {
  tab: {
    role: async () => (await current)?.role,
    failure: () => failure,
    write: async (id: string, body: string) => {
      await (await mesh()).on().unwrap().db.insert(notes).values({ id, body });
    },
    ids: async () =>
      ((await (await mesh()).query?.("SELECT id FROM notes ORDER BY id")) ?? []).map(
        (row) => row[0],
      ),
    session: async () =>
      (
        await (await mesh()).query?.("SELECT value FROM syncmesh.meta WHERE key = 'session'")
      )?.[0]?.[0],
    seen: () => [...seen],
    /** The origin's OPFS root holds the pool, and the pool's lock is held by some context. */
    durable: async () => {
      const root = await navigator.storage.getDirectory();
      const names: string[] = [];
      for await (const name of root.keys()) names.push(name);
      const locks = await navigator.locks.query();
      return {
        root: names,
        held: (locks.held ?? [])
          .map((lock) => lock.name ?? "")
          .toSorted((x, y) => x.localeCompare(y)),
      };
    },
    /** What this tab gets opening a database of its own, beside the origin's mesh. */
    direct: async () => {
      const opened = await wasmSqliteDriver({ name: "direct" });
      return opened.isErr() ? opened.error._tag : opened.value.storage;
    },
    hide: () => turn("hidden"),
    show: () => turn("visible"),
  },
});
