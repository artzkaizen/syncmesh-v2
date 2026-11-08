import type { RelaySocket, WindowConnection } from "@syncmesh/relay";
import type { ServerWebSocket } from "bun";

import { serveWindows } from "@syncmesh/relay";
import { panic } from "@syncmesh/result";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { createWindowClient } from "@syncmesh/window";
import { createIdentity } from "@syncmesh/wire";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AuthorityUnreachable, createClient, sqlite } from "../index.js";
import {
  ALICE,
  POSTGRES_URL,
  at,
  eventually,
  mailId,
  seedMailbox,
  served,
} from "./served-fixtures.js";

const suite = POSTGRES_URL === undefined ? describe.skip : describe;

type Fixture = Awaited<ReturnType<typeof served>>;

const identity = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();

/** A WebSocket as E12's sender drives one: Bun's -1 is buffered, 0 is dropped. */
const relaySocket = (ws: ServerWebSocket<unknown>): RelaySocket => ({
  send: (frame) => {
    const sent = ws.send(frame);
    return sent === -1 ? "buffered" : sent === 0 ? "dropped" : "sent";
  },
  close: (reason) => ws.close(1000, reason),
});

suite("useLiveQuery's read of a served table, over a real socket, from Postgres (D43)", () => {
  let fx: Fixture;
  let server: ReturnType<typeof Bun.serve>;
  const connections = new Map<ServerWebSocket<unknown>, WindowConnection>();

  beforeAll(async () => {
    fx = await served({ seed: seedMailbox(100) });
    // the host: authenticate the socket (here, alice), then serve her windows on it
    server = Bun.serve({
      port: 0,
      fetch: (request, host) =>
        host.upgrade(request, { data: undefined })
          ? undefined
          : new Response("upgrade", { status: 426 }),
      websocket: {
        open: (ws) =>
          void connections.set(ws, serveWindows(relaySocket(ws), { source: fx.sourceFor(ALICE) })),
        message: (ws, message) => {
          if (message instanceof Uint8Array) connections.get(ws)?.receive(message);
        },
        drain: (ws) => connections.get(ws)?.drain(),
        close: (ws) => {
          connections.get(ws)?.close();
          connections.delete(ws);
        },
      },
    });
  });
  afterAll(async () => {
    await server.stop(true);
    await fx.close();
  });

  /** The app's client, its windows riding a WebSocket to the host. */
  const connect = async () => {
    const windows = createWindowClient();
    const socket = new WebSocket(`ws://localhost:${server.port ?? panic("no port")}`);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) windows.receive(new Uint8Array(event.data));
    };
    await new Promise((resolve) => (socket.onopen = resolve));
    windows.attach((frame) => socket.send(frame));
    const client = createClient({
      schema: fx.schema,
      procedures: fx.router,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      windows,
    });
    await client.$ready;
    return { client, socket };
  };

  test("the descriptor useLiveQuery holds answers from Postgres, and a SQL INSERT arrives live", async () => {
    const { client, socket } = await connect();
    const call = client.mail.inbox({ folder: "inbox", limit: 3 });
    const live = call["~mesh"].live();
    const deliveries: string[][] = [];
    live.subscribe((rows) => deliveries.push(rows.map((r) => r.id)));
    const first = await live.ready;
    expect(first.map((r) => r.id)).toEqual([100, 99, 98].map(mailId));
    // the same T a local read returns: the timestamp column hands back a Date
    expect(first[0]?.received).toEqual(new Date(at(100).epochMilliseconds));
    expect(live.snapshot()).toMatchObject({ answered: true, status: "success" });

    await fx.pg.unsafe(
      `INSERT INTO ${fx.names.mail} VALUES ($1, 'alice', 'inbox', $2, 'written straight into Postgres')`,
      [mailId(101), at(101).toString()],
    );
    await eventually(() => live.data()?.[0]?.id === mailId(101), "the SQL insert on screen");
    expect(live.data()?.map((r) => r.subject)[0]).toBe("written straight into Postgres");
    const snapshot = live.snapshot();
    expect(snapshot.answered && [...snapshot.diff.added.keys()]).toEqual([mailId(101)]);
    expect(snapshot.answered && [...snapshot.diff.removed.keys()]).toEqual([mailId(98)]);
    expect(deliveries.at(-1)).toEqual([101, 100, 99].map(mailId));

    // the next page is the same call with `after`; a one-shot await is the same read
    const page = await client.mail.inbox({
      folder: "inbox",
      limit: 2,
      after: { received: at(99).toString(), id: mailId(99) },
    });
    expect(page.unwrap().data.map((r) => r.id)).toEqual([98, 97].map(mailId));

    live.release();
    socket.close();
    await client.$close();
  });

  test("two holders of one call share one window; the last release closes it", async () => {
    const { client, socket } = await connect();
    const a = client.mail.inbox({ folder: "inbox", limit: 2 })["~mesh"].live();
    const b = client.mail.inbox({ folder: "inbox", limit: 2 })["~mesh"].live();
    await Promise.all([a.ready, b.ready]);
    const [held] = [...connections.values()].slice(-1);
    await held?.windows.idle();
    expect(held?.windows.held()).toBe(2);
    a.release();
    await held?.windows.idle();
    expect(held?.windows.held()).toBe(2);
    b.release();
    await eventually(
      async () => (await held?.windows.idle(), held?.windows.held() === 0),
      "the close",
    );
    socket.close();
    await client.$close();
  });

  test("a one-shot read with no socket fails as unreachable instead of waiting forever", async () => {
    const client = createClient({
      schema: fx.schema,
      procedures: fx.router,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      // configured, and never attached: the device is offline
      windows: createWindowClient(),
    });
    await client.$ready;
    const answer = await client.mail.inbox({ folder: "inbox", limit: 2 });
    expect(answer.isErr() && answer.error).toBeInstanceOf(AuthorityUnreachable);
    await client.$close();
  });

  test("a one-shot read whose socket goes before the answer fails as unreachable", async () => {
    const windows = createWindowClient();
    // a socket that takes the desire and never answers, then goes
    windows.attach(() => undefined);
    const client = createClient({
      schema: fx.schema,
      procedures: fx.router,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      windows,
    });
    await client.$ready;
    const pending = client.mail.inbox({ folder: "inbox", limit: 2 });
    await eventually(
      () => windows.status() === "resyncing" || windows.status() === "live",
      "the desire",
    );
    windows.detach();
    const answer = await pending;
    expect(answer.isErr() && answer.error).toBeInstanceOf(AuthorityUnreachable);
    await client.$close();
  });

  test("a client with no windows configured fails the read by name instead of showing nothing", async () => {
    const client = createClient({
      schema: fx.schema,
      procedures: fx.router,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    });
    await client.$ready;
    const answer = await client.mail.inbox({ folder: "inbox", limit: 2 });
    expect(answer.isErr() && answer.error.message).toBe(
      'mail.inbox reads a sync: "window" table, which the server serves, and no windows were configured',
    );
    await client.$close();
  });
});
