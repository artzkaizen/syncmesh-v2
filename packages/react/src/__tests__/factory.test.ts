import "./dom.js";
import type { AuthStatus, MeshStatus, PeerGraph } from "@syncmesh/client";
import type { PeerId } from "@syncmesh/kernel";
import type { LinkEvent, Route, Transport } from "@syncmesh/transport";

import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";

import type { Reading } from "../use-status.js";

import { syncmeshReact } from "../factory.js";
import { useLinkEvents } from "../use-links.js";
import { usePeers } from "../use-peers.js";
import { useRoutes } from "../use-routes.js";
import { useSession } from "../use-session.js";
import { useStatus } from "../use-status.js";
import { mount } from "./mount.js";

/**
 * The factory and the diagnostic hooks, over a client made of the six functions each one reads.
 *
 * Nothing here opens an engine. What is under test is the seam — that a promised client is drawn
 * as `whileOpening` and then as the tree, that `api` is a property under the provider and a
 * sentence above it, that each hook re-renders when its feed speaks and holds its snapshot when
 * nothing changed — and an engine would only make those questions slower.
 */

/** One listener set, and a `fire` for the test to speak through it. */
const feed = () => {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    fire: () => {
      for (const listener of listeners) listener();
    },
  };
};

// SAFETY: a fixture id; nothing here verifies it
const peer = (name: string) => name as PeerId;
const T0 = Temporal.Instant.from("2026-09-21T09:00:00Z");

/** A client with every diagnostic surface, each one a knob the test turns. */
const fakeClient = () => {
  const status = feed();
  const auth = feed();
  const routes = feed();
  const links = new Set<(event: LinkEvent) => void>();
  let health: MeshStatus["health"] = "local-ready";
  let reaches = new Set<PeerId>();
  let principal: AuthStatus["principal"] = null;
  let known: readonly Route[] = [];
  let graph: PeerGraph = { edges: [], self: peer("me"), silent: ["relay"] };

  const ble: Transport = {
    kind: "ble",
    name: "nearby",
    reaches: () => reaches,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
  };

  const client = {
    $auth: {
      status: (): AuthStatus => ({ expiresAt: null, principal }),
      subscribe: auth.subscribe,
    },
    $peers: { graph: () => graph },
    $routes: { all: () => known, onChange: routes.subscribe },
    $status: {
      get: (): MeshStatus => ({
        health,
        sources: new Map([["nearby", { condition: "ok" as const, kind: "ble" as const }]]),
      }),
      subscribe: status.subscribe,
    },
    $transports: {
      forced: () => [],
      list: () => [ble],
      onLinkEvent: (listener: (event: LinkEvent) => void) => {
        links.add(listener);
        return () => void links.delete(listener);
      },
    },
  };

  return {
    client,
    setHealth: (next: MeshStatus["health"]) => {
      health = next;
      status.fire();
    },
    prove: (who: PeerId) => {
      reaches = new Set([...reaches, who]);
      graph = { ...graph, edges: [{ over: ["nearby"], peer: who }] };
      const event: LinkEvent = { at: T0, kind: "proven", peer: who, transport: "nearby" };
      for (const listener of links) listener(event);
    },
    signIn: (account: string) => {
      principal = { account, claims: {}, role: "member" };
      auth.fire();
    },
    learn: (route: Route) => {
      known = [...known, route];
      routes.fire();
    },
    nudge: () => status.fire(),
  };
};

type Fake = ReturnType<typeof fakeClient>["client"];

describe("syncmeshReact", () => {
  test("a promised client is drawn as whileOpening, then as the tree, and api is there underneath", async () => {
    const { client } = fakeClient();
    let resolve: (value: Fake) => void = () => undefined;
    const mesh = syncmeshReact(
      new Promise<Fake>((done) => {
        resolve = done;
      }),
    );
    const seen: string[] = [];
    const Screen = () => {
      seen.push(mesh.api === client ? "client" : "other");
      return null;
    };
    const { container, settle } = await mount(
      createElement(
        mesh.Provider,
        { whileOpening: createElement("i", null, "opening") },
        createElement(Screen),
      ),
    );
    expect(container.textContent).toBe("opening");
    expect(seen).toEqual([]);
    // above the provider, before the answer: a sentence, not undefined
    expect(() => mesh.api).toThrow("has not opened yet");

    await act(async () => resolve(client));
    await settle();
    expect(container.textContent).toBe("");
    expect(seen).toEqual(["client"]);
    expect(mesh.api).toBe(client);
  });

  test("a client that is a value is there on the first frame, and whileOpening never draws", async () => {
    const { client } = fakeClient();
    const mesh = syncmeshReact(client);
    expect(mesh.api).toBe(client);
    const seen: Fake[] = [];
    const Screen = () => {
      seen.push(mesh.api);
      return null;
    };
    const { container } = await mount(
      createElement(
        mesh.Provider,
        { whileOpening: createElement("i", null, "opening") },
        createElement(Screen),
      ),
    );
    expect(container.textContent).toBe("");
    expect(seen).toEqual([client]);
  });

  test("a refused open is drawn with its reason, the tree is withheld, and api says why", async () => {
    const mesh = syncmeshReact(Promise.reject<Fake>(new Error("no database here")));
    const seen: string[] = [];
    const Screen = () => {
      seen.push("drawn");
      return null;
    };
    const { container, settle } = await mount(
      createElement(
        mesh.Provider,
        { whenUnavailable: (error) => createElement("b", null, error.message) },
        createElement(Screen),
      ),
    );
    await settle();
    expect(container.textContent).toBe("no database here");
    expect(seen).toEqual([]);
    expect(() => mesh.api).toThrow("no database here");
  });

  test("the bound hooks read the client the factory holds", async () => {
    const fake = fakeClient();
    const mesh = syncmeshReact(fake.client);
    const readings: Reading[] = [];
    const Screen = () => {
      readings.push(mesh.useStatus());
      return null;
    };
    const { settle } = await mount(createElement(mesh.Provider, null, createElement(Screen)));
    expect(readings.at(-1)?.sources.get("nearby")?.reaches).toBe(0);
    await act(async () => fake.prove(peer("4a825aca")));
    await settle();
    expect(readings.at(-1)?.sources.get("nearby")?.reaches).toBe(1);
  });
});

describe("the diagnostic hooks", () => {
  test("useStatus holds its snapshot until something moved, and counts what a medium reaches", async () => {
    const fake = fakeClient();
    const readings: Reading[] = [];
    const Screen = () => {
      readings.push(useStatus(fake.client));
      return null;
    };
    const { settle } = await mount(createElement(Screen));
    expect(readings.at(-1)?.sources.get("nearby")).toEqual({
      condition: "ok",
      forced: false,
      kind: "ble",
      reaches: 0,
    });
    const before = readings.length;

    // the feed spoke and nothing changed: the same object, and no render
    await act(async () => fake.nudge());
    await settle();
    expect(readings.length).toBe(before);

    await act(async () => fake.prove(peer("4a825aca")));
    await settle();
    expect(readings.at(-1)?.sources.get("nearby")?.reaches).toBe(1);

    await act(async () => fake.setHealth("offline"));
    await settle();
    expect(readings.at(-1)?.health).toBe("offline");
  });

  test("usePeers gains an edge when a link is proven, and names the media it cannot count", async () => {
    const fake = fakeClient();
    const graphs: PeerGraph[] = [];
    const Screen = () => {
      graphs.push(usePeers(fake.client));
      return null;
    };
    const { settle } = await mount(createElement(Screen));
    expect(graphs.at(-1)).toEqual({ edges: [], self: peer("me"), silent: ["relay"] });

    await act(async () => fake.prove(peer("4a825aca")));
    await settle();
    expect(graphs.at(-1)?.edges).toEqual([{ over: ["nearby"], peer: peer("4a825aca") }]);
  });

  test("useLinkEvents keeps the story newest first, and no more of it than asked", async () => {
    const fake = fakeClient();
    let events: readonly LinkEvent[] = [];
    const Screen = () => {
      events = useLinkEvents(fake.client, 2);
      return null;
    };
    const { settle } = await mount(createElement(Screen));
    for (const who of ["a", "b", "c"]) await act(async () => fake.prove(peer(who)));
    await settle();
    expect(events.map((event) => event.peer)).toEqual([peer("c"), peer("b")]);
  });

  test("useSession re-renders on sign-in and holds when the answer is the same", async () => {
    const fake = fakeClient();
    const sessions: AuthStatus[] = [];
    const Screen = () => {
      sessions.push(useSession(fake.client));
      return null;
    };
    const { settle } = await mount(createElement(Screen));
    expect(sessions.at(-1)?.principal).toBeNull();

    await act(async () => fake.signIn("acct_bo"));
    await settle();
    expect(sessions.at(-1)?.principal?.account).toBe("acct_bo");
    const before = sessions.length;

    await act(async () => fake.signIn("acct_bo"));
    await settle();
    expect(sessions.length).toBe(before);
  });

  test("useRoutes learns a way to the authority", async () => {
    const fake = fakeClient();
    let routes: readonly Route[] = [];
    const Screen = () => {
      routes = useRoutes(fake.client);
      return null;
    };
    const { settle } = await mount(createElement(Screen));
    expect(routes).toEqual([]);

    await act(async () =>
      fake.learn({ expiresAt: T0, hops: 2, to: "authority", via: peer("4a825aca") }),
    );
    await settle();
    expect(routes.map((route) => `${route.to} via ${route.via} in ${String(route.hops)}`)).toEqual([
      "authority via 4a825aca in 2",
    ]);
  });
});
