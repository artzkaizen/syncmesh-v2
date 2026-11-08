import "./dom.js";
import type { Transport, TransportContext } from "@syncmesh/transport";
import type { LoroDoc } from "loro-crdt";

import { getRecord, type ColumnName } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { Temporal } from "@syncmesh/temporal";
import { lan } from "@syncmesh/transports";
import { virtualLan } from "@syncmesh/transports/testing";
import {
  createGrantRegistry,
  createIdentity,
  decodeAndVerifyPresence,
  issueGrant,
  signPresence,
} from "@syncmesh/wire";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CursorEphemeralStore,
  LoroEphemeralCursorPlugin,
  LoroSyncPlugin,
  type LoroDocType,
} from "loro-prosemirror";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shareEphemeral, type EphemeralCarrier } from "../ephemeral.js";
import { DOC, N1, NOTES, W1, insertNote, node, until } from "./fixtures.js";

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ISSUER = createIdentity(seed(1)).unwrap();
/* oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- the presence topic's one column */
const STATE = "state" as ColumnName;

/**
 * A device as an app holds one: an engine with the document runtime, a grant for the workspace,
 * and the presence frames it hears handed to whoever listens for cursors.
 */
function device(n: number) {
  const base = node(n);
  const grants = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
  const grant = issueGrant(ISSUER, {
    account: `acct_${String(n)}`,
    device: base.identity.peerId,
    role: "member",
    partitions: [W1],
    validFor: Temporal.Duration.from({ days: 1 }),
    now: T0,
  });
  grants.register(grant).unwrap();
  const heard = new Set<(bytes: Uint8Array) => void>();
  const context: TransportContext = {
    engine: base.engine,
    identity: base.identity,
    grants,
    now: () => T0,
    onPresence: (wire) => {
      const verified = decodeAndVerifyPresence(wire);
      const state = verified.isOk() ? verified.value.presence.value?.get(STATE) : undefined;
      if (state instanceof Uint8Array) for (const listener of heard) listener(state);
    },
  };
  let transport: Transport | undefined;
  let count = 0;
  const session = crypto.randomUUID();
  /** Cursor bytes as signed presence on the live transport — syncmesh's ephemeral tier. */
  const carrier: EphemeralCarrier = {
    publish: (bytes) => {
      count += 1;
      const signed = signPresence(
        {
          v: 1,
          peerId: base.identity.peerId,
          topic: "cursor",
          partition: W1,
          session,
          count,
          value: new Map([[STATE, bytes]]),
          expires: Date.now() + 30_000,
        },
        base.identity,
      );
      transport?.sendPresence?.(signed.wire);
    },
    subscribe: (listener) => {
      heard.add(listener);
      return () => heard.delete(listener);
    },
  };
  const connect = async (next: Transport) => {
    transport = next;
    await next.start(context);
    await next.whenReady();
  };
  const disconnect = async () => {
    await transport?.stop();
    transport = undefined;
  };
  return { ...base, connect, disconnect, carrier };
}

type Device = ReturnType<typeof device>;

/** A TipTap editor bound to a document through loro-prosemirror, with its cursors shared. */
function editorOn(doc: LoroDoc, d: Device, name: string) {
  const cursors = new CursorEphemeralStore(doc.peerIdStr);
  // in the document, as on a page: a detached editor never has focus, so never a cursor
  const element = document.body.appendChild(document.createElement("div"));
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Extension.create({
        name: "loro",
        addProseMirrorPlugins: () => [
          // SAFETY: the column's LoroDoc is the document loro-prosemirror's typing names
          LoroSyncPlugin({ doc: doc as LoroDocType }),
          LoroEphemeralCursorPlugin(cursors, { user: { name, color: "#3366ff" } }),
        ],
      }),
    ],
  });
  const unshare = shareEphemeral(cursors, d.carrier);
  return { editor, cursors, stop: () => (unshare(), editor.destroy(), element.remove()) };
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Two devices, two editors on one note, converging and sharing cursors over `dial`. */
async function scenario(dial: (d: Device, name: string) => Transport) {
  const a = device(50);
  const b = device(60);
  await insertNote(a);
  await a.connect(dial(a, "a"));
  await b.connect(dial(b, "b"));
  cleanup.push(a.disconnect, b.disconnect, a.documents.stop, b.documents.stop);
  expect(await until(() => getRecord(b.engine.state(), NOTES, N1) !== undefined, 5000)).toBe(true);

  // the note's author lays the document out once; a second empty layout made concurrently
  // would be a second root, which is the lineage problem `replace()` exists for (RFC-0023 §5.3)
  const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
  const ea = editorOn(da.value, a, "Ada");
  cleanup.push(ea.stop);
  (await da.flush()).unwrap();
  expect(await until(async () => (await b.engine.docLog()).unwrap().length === 1, 5000)).toBe(true);
  const db = (await b.documents.open<LoroDoc>(DOC)).unwrap();
  const eb = editorOn(db.value, b, "Bo");
  cleanup.push(eb.stop);
  const same = () => ea.editor.getText() === eb.editor.getText();

  // live: each types, both editors show both
  ea.editor.commands.insertContent("Hello from Ada. ");
  expect(await until(() => eb.editor.getText().includes("Hello from Ada."), 5000)).toBe(true);
  eb.editor.commands.insertContentAt(eb.editor.state.doc.content.size - 1, "Bo was here.");
  expect(await until(() => same() && ea.editor.getText().includes("Bo was here."), 5000)).toBe(
    true,
  );

  // offline: b drops off, both keep typing, and the link's return merges every keystroke
  await b.disconnect();
  ea.editor.commands.insertContentAt(1, "[ada offline] ");
  eb.editor.commands.insertContentAt(1, "[bo offline] ");
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(same()).toBe(false);
  await b.connect(dial(b, "b"));
  expect(await until(same, 5000)).toBe(true);
  for (const piece of ["Hello from Ada.", "Bo was here.", "[ada offline]", "[bo offline]"])
    expect(ea.editor.getText()).toContain(piece);
  expect(da.value.oplogVersion().compare(db.value.oplogVersion())).toBe(0);

  // cursors ride the ephemeral tier: Ada's selection reaches Bo, and never the log
  const logged = (await a.engine.docLog()).unwrap().length;
  ea.editor.commands.focus();
  ea.editor.commands.setTextSelection({ from: 2, to: 6 });
  expect(
    await until(() => eb.cursors.getAll()[da.value.peerIdStr]?.anchor !== undefined, 5000),
  ).toBe(true);
  expect(eb.cursors.getAll()[da.value.peerIdStr]?.user?.name).toBe("Ada");
  expect((await a.engine.docLog()).unwrap().length).toBe(logged);
}

describe("two TipTap editors on one loro@1 column, through the mesh", () => {
  test("through a relay: live edits converge, offline edits merge, cursors are shared", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-loro-relay-"));
    const relay = await startRelay(0, { dataDir, keepaliveMs: 60_000 });
    cleanup.push(
      () => rmSync(dataDir, { recursive: true, force: true }),
      () => relay.stop(),
    );
    await scenario(() => relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 }));
  }, 20_000);

  test("peer to peer over a LAN, no relay: the same", async () => {
    const air = virtualLan();
    await scenario((_d, name) =>
      lan({
        id: "the-desk",
        network: air.networkFor(name, [name === "a" ? "b" : "a"]),
        name: `lan:${name}`,
      }),
    );
  }, 20_000);
});
