import "./dom.js";
import { createMesh } from "@syncmesh/client";
import { parsePeerId, type SeqNum } from "@syncmesh/kernel";
import { meshApi, mutation, query } from "@syncmesh/orpc";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";

import { useCan } from "../use-can.js";
import { useLiveQuery } from "../use-live-query.js";
import { useSyncOf } from "../use-sync-of.js";

const book = sqliteTable("book", { id: text().primaryKey(), title: text().notNull() });

const schema = defineSchema({
  partitions: { org: {} },
  roles: { org: ["owner", "member"] },
  tables: {
    book: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: "org",
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

const books = {
  list: query.handler(({ mesh }) => mesh.db.select().from(book).orderBy(asc(book.id))),
  create: mutation
    .input(z.object({ id: z.string(), title: z.string().min(1) }))
    .handler(async ({ input, mesh }) => {
      await mesh.db.insert(book).values(input);
      return { id: input.id };
    }),
};

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 3 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = "org:acme";

const open = async () => {
  const mesh = (
    await createMesh({
      schema,
      identity: device,
      issuer: issuer.peerId,
      driver: bunSqliteDriver(":memory:"),
      now: () => T0,
    })
  ).unwrap();
  mesh.grants
    .register(
      issueGrant(issuer, {
        account: "acct_me",
        device: device.peerId,
        role: "member",
        // SAFETY: a test fixture instance in the documented kind:id form
        partitions: [ACME] as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
    )
    .unwrap();
  return { mesh, api: meshApi(mesh, { books }, { instance: ACME }) };
};

const mount = async (element: Parameters<Root["render"]>[0]) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(element));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
  await settle();
  return { settle };
};

describe("useLiveQuery over api.*", () => {
  test("a component names the call and nothing else; a write re-renders it", async () => {
    const { mesh, api } = await open();
    const renders: string[] = [];

    const List = () => {
      const { data, isPending, isSettled, error } = useLiveQuery(api.books.list());
      renders.push(
        error !== undefined
          ? `err:${error.message}`
          : `${isPending ? "…" : data.map((b) => b.title).join(",")}|settled=${String(isSettled)}`,
      );
      return null;
    };

    const { settle } = await mount(createElement(List));
    // no transports: every source has answered, and the list is empty because it is empty
    expect(renders.at(-1)).toBe("|settled=true");

    await act(async () => {
      (await api.books.create({ id: "b1", title: "Dune" })).unwrap();
    });
    await settle();
    expect(renders.at(-1)).toBe("Dune|settled=true");

    const before = renders.length;
    await act(async () => {
      (await api.books.create({ id: "b2", title: "Ubik" })).unwrap();
    });
    await settle();
    expect(renders.at(-1)).toBe("Dune,Ubik|settled=true");
    expect(renders.length).toBeGreaterThan(before);

    await mesh.stop();
  });

  test("api.$can gates a button without the component naming a mesh or an instance", async () => {
    const { mesh, api } = await open();
    let allowed: boolean | undefined;
    const Button = () => {
      allowed = useCan(api.$can, "book.insert");
      return null;
    };
    await mount(createElement(Button));
    expect(allowed).toBe(true);
    await mesh.stop();
  });

  test("a row's receipt updates itself when the acknowledgement lands", async () => {
    const { mesh, api } = await open();
    const seen: (string | undefined)[] = [];
    const Row = ({ id }: { readonly id: string }) => {
      seen.push(useSyncOf(api.$sync, "book", id));
      return null;
    };

    (await api.books.create({ id: "b1", title: "Dune" })).unwrap();
    const { settle } = await mount(createElement(Row, { id: "b1" }));
    expect(seen.at(-1)).toBe("local");

    // a peer says it holds everything this device has authored — no re-render is asked for
    await act(async () => {
      const peer = parsePeerId("a".repeat(64)).unwrap();
      // SAFETY: the sequence this device has reached; zero is the floor before any write
      const none = 0 as SeqNum;
      const mine = mesh.engine.coverage().synced.get(device.peerId) ?? none;
      mesh.engine.acknowledge(peer, new Map([[device.peerId, mine]]), T0);
    });
    await settle();

    expect(seen.at(-1)).toBe("delivered");
    await mesh.stop();
  });

  test("input the schema refuses never reaches the table", async () => {
    const { mesh, api } = await open();
    const refused = await api.books.create({ id: "b3", title: "" });
    expect(refused.isErr()).toBe(true);

    const rows = await api.books.list().run();
    expect(rows).toEqual([]);
    await mesh.stop();
  });
});
