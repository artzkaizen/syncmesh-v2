import type { Transport } from "@syncmesh/transport";

import { seed } from "@syncmesh/kernel/test-fixtures";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { createIdentity } from "@syncmesh/wire";
import { afterEach, describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { AppPhase, Knock } from "../transports.js";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text() });
const schema = () =>
  syncSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
  });

/** A medium that counts how often it was told to look at its link again. */
const medium = () => {
  let woken = 0;
  const transport: Transport = {
    name: "counted",
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    wake: () => void (woken += 1),
  };
  return { transport, woken: () => woken };
};

/** A platform that says which phase the app is in, on demand. */
const phases = () => {
  const listening = new Set<(phase?: AppPhase) => void>();
  const knock: Knock = (wake) => {
    listening.add(wake);
    return () => void listening.delete(wake);
  };
  return {
    knock,
    say: (phase: AppPhase) => {
      for (const wake of listening) wake(phase);
    },
  };
};

const until = async (check: () => Promise<boolean>, ms = 2000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
};

const WRITER = createIdentity(seed(7)).unwrap();

const meshOn = async (knocks: readonly Knock[] = [], transports: readonly Transport[] = []) => {
  const driver = bunSqliteDriver(":memory:");
  const mesh = (
    await createMesh({
      schema: schema(),
      identity: WRITER,
      storage: sqlite({ driver }),
      // the writer is the authority, so it may write the global table
      trust: { authority: WRITER.peerId },
      knocks: [...knocks],
      transports: [...transports],
    })
  ).unwrap();
  const session = async () =>
    (await driver.all(`SELECT value FROM syncmesh.meta WHERE key = 'session'`))[0]?.[0];
  return { mesh, session };
};

describe("the log's session follows the app into the background and back (D39)", () => {
  test("a knock naming the background marks it clean and wakes nothing; the foreground reopens it", async () => {
    const platform = phases();
    const counted = medium();
    const { mesh, session } = await meshOn([platform.knock], [counted.transport]);
    await mesh.ready();
    expect(await session()).toBe("open");

    platform.say("background");
    expect(await until(async () => (await session()) === "closed")).toBe(true);
    expect(counted.woken()).toBe(0);

    platform.say("foreground");
    expect(await until(async () => (await session()) === "open")).toBe(true);
    // and coming back is a knock like any other: every medium looks at its link again
    expect(counted.woken()).toBe(1);

    await mesh.stop();
    expect(await session()).toBe("closed");
  });

  test("a write made in the background marks the session open again before it lands", async () => {
    const platform = phases();
    const { mesh, session } = await meshOn([platform.knock], [medium().transport]);
    await mesh.ready();
    platform.say("background");
    expect(await until(async () => (await session()) === "closed")).toBe(true);

    // still backgrounded: the log is written, so a power loss now must not skip the check
    await mesh.on().unwrap().db.insert(notes).values({ id: "n1", body: "late" });
    expect(await session()).toBe("open");

    // and the next trip to the background marks it clean again
    platform.say("foreground");
    platform.say("background");
    expect(await until(async () => (await session()) === "closed")).toBe(true);
    await mesh.stop();
  });
});

/**
 * A page's `document` and window events, as far as the lifecycle needs them: Bun's global scope
 * has neither a document nor typed window events, so both are stood in for and put back after.
 */
const window = new EventTarget();
interface WindowEvents {
  readonly addEventListener?: unknown;
  readonly removeEventListener?: unknown;
}
const eventsOf = (scope: WindowEvents) => ({
  add: scope.addEventListener,
  remove: scope.removeEventListener,
});
const held = eventsOf(globalThis);
const fakePage = () => {
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  Object.assign(globalThis, {
    document: page,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
  });
  return {
    hide: () => {
      page.visibilityState = "hidden";
      page.dispatchEvent(new Event("visibilitychange"));
    },
    show: () => {
      page.visibilityState = "visible";
      page.dispatchEvent(new Event("visibilitychange"));
    },
  };
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  Object.assign(globalThis, { addEventListener: held.add, removeEventListener: held.remove });
});

describe("on a page, with no knock named (D39)", () => {
  test("hidden marks the session clean and visible reopens it; pagehide alone does too", async () => {
    const page = fakePage();
    const { mesh, session } = await meshOn();
    expect(await session()).toBe("open");

    page.hide();
    expect(await until(async () => (await session()) === "closed")).toBe(true);
    page.show();
    expect(await until(async () => (await session()) === "open")).toBe(true);

    window.dispatchEvent(new Event("pagehide"));
    expect(await until(async () => (await session()) === "closed")).toBe(true);
    window.dispatchEvent(new Event("pageshow"));
    expect(await until(async () => (await session()) === "open")).toBe(true);
    await mesh.stop();
  });
});
