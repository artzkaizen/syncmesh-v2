import type { MeshStatus, OperationsView } from "@syncmesh/client";
import type { DevtoolsLinkEvent } from "@syncmesh/devtools";
import type { Client } from "@syncmesh/orpc";
import type { Transport } from "@syncmesh/transport";

import { deviceIdentity } from "@syncmesh/client";
import { createLinkRing } from "@syncmesh/devtools";
import {
  DEFAULT_ACTOR,
  actorGrant,
  forgetActor,
  issuesSchema,
  procedures,
  rememberActor,
  storedActor,
  type Actor,
  type IssuesPresence,
} from "@syncmesh/issues";
import { createClient, httpLink, sqlite } from "@syncmesh/orpc";
import { foreground } from "@syncmesh/react-native";
import { devServerHost } from "@syncmesh/react-native/dev-server";
import { reachability } from "@syncmesh/react-native/network";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { Result, TaggedError } from "@syncmesh/result";
import { expoSqliteDriver } from "@syncmesh/sqlite-expo";
import { createIdentity } from "@syncmesh/wire";
import Constants from "expo-constants";
import { deleteDatabaseAsync } from "expo-sqlite";
import { DevSettings } from "react-native";
import { z } from "zod";

import type { Scale } from "./measure";

import { bleOverAir } from "./ble";
import { reportSightings, watchLinks } from "./link-log";
import { MEASURING } from "./measuring";
import { watchSql } from "./sql-trace";
import { wifiOverAir } from "./wifi";

/**
 * The tracker's replica, on a phone.
 *
 * This file is the whole of what a second platform costs. The domain above it — the manifest, the
 * procedures, the seed — is `@syncmesh/issues`, imported unchanged from the package the browser
 * app imports, because it names no driver and no database (`apps/issues/src/index.ts` says so in
 * its own first paragraph). What changes here is one line: where the SQLite lives. A tab gets
 * OPFS through a worker it elected; a phone gets a file in its own sandbox, and `expo-sqlite` is
 * synchronous there, so there is no worker, no election and no port — the engine is simply on the
 * thread that asks it things.
 *
 * **This device is a peer, not a viewer.** It holds the log, folds it, and answers every read out
 * of its own database; the relay is a *source* behind that, not in front of it. Put the phone in
 * aeroplane mode and the list still draws, the writes still commit, and the badge says why nothing
 * has been acknowledged — which is a different sentence from an app that went blank.
 */

/** The replica could not be opened, with the reason in a sentence a person can act on. */
export class MeshUnavailable extends TaggedError("MeshUnavailable")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * The sentence, and what actually went wrong underneath it.
 *
 * A screen that shows only "the mesh could not open over the database" tells a person nothing they
 * can act on, and the cause is right there — so it is carried into the message rather than left
 * for a console nobody on a phone is reading. `cause` is kept beside it for the same reason every
 * error in this codebase keeps one.
 */
const because = (message: string) => (cause: unknown) => {
  // eslint-disable-next-line no-console -- a phone has no other place to put a stack
  if (cause instanceof Error) console.error(`[mesh] ${message}`, cause.stack);
  return new MeshUnavailable({
    cause,
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });
};

const bytes = (n: number) => Uint8Array.from({ length: 32 }, (_, index) => (n + index) % 256);

/**
 * The demo's shared anchors, byte-for-byte the browser app's (`apps/issues/src/app/identity.ts`).
 *
 * They have to match or the two installs are two workspaces wearing one name: a device compares
 * every event it folds against `trust`, so a phone with a different issuer would quarantine every
 * write the laptop made and call the result "caught up". The private issuer half being in this
 * bundle is the same shortcut documented there, and the same thing a real deployment replaces with
 * a round trip.
 */
const issuer = createIdentity(bytes(1)).unwrap();
const authority = createIdentity(bytes(200)).unwrap();

/**
 * Where this phone looks for the relay and the authority.
 *
 * `localhost` is the one address that cannot work here: on a device it means the *phone*, and the
 * relay is on the laptop. The machine that served this bundle is the one running both, and
 * `devServerHost` is how a React Native app finds it — the deep-path lookup, the two sources that
 * are absent in different situations, and the reasons each of them is, all live in
 * `@syncmesh/react-native` now, because every app on this platform hits exactly that wall.
 *
 * `extra.relayUrl` in `app.json` overrides for the case the two are different machines, and it is
 * what a release build has to use: there is no dev server then, and where the relay lives is not
 * something an app can work out for itself.
 */
/**
 * Expo's config, parsed where it arrives.
 *
 * `app.json` reaches this file through a native runtime, so it is `unknown` until something says
 * otherwise — and `Address` is that something. An absent key matters: `String(undefined)` is
 * `"undefined"`, which is a perfectly dialable nonsense URL, so the schema refuses the empty case
 * rather than letting it become a connection attempt.
 */
const Address = z.string().min(1);

/**
 * A count out of a driver's cell, which arrives as `unknown` and is sometimes nothing at all.
 *
 * `sum()` over an empty table is SQL `NULL`, not `0`, so a fresh install's first reading has a real
 * absence in it — and a scale that read `null` as the size of this replica would be a number on a
 * screen that means nothing. Zero is the honest answer for "no rows yet", and it is the only value
 * this ever substitutes: anything a driver hands back that is a number is that number.
 */
const Count = z.number().catch(0);

const configured = (key: "relayUrl" | "authorityUrl"): string | undefined => {
  const found = Address.safeParse(Constants.expoConfig?.extra?.[key]);
  return found.success ? found.data : undefined;
};

/**
 * The last resort, and the one that is wrong on a device.
 *
 * On a simulator `localhost` is the Mac and it works by accident; on a phone it is the phone, so
 * the relay is never reached, nothing syncs, and the workspace reads as empty rather than as
 * unreachable. It is kept because this is a demo that has to start *somewhere* on a simulator with
 * no config — a real deployment sets `extra.relayUrl` and never reaches this line.
 */
const lanHost = (): string => devServerHost() ?? "localhost";

const RELAY_URL = configured("relayUrl") ?? `ws://${lanHost()}:5241/issues`;
const AUTHORITY_URL = configured("authorityUrl") ?? `http://${lanHost()}:5252`;

// eslint-disable-next-line no-console -- a device pointed at the wrong machine looks like an empty
// workspace, and this one line is the difference between diagnosing that and guessing at it
console.log(`[mesh] relay ${RELAY_URL} · authority ${AUTHORITY_URL}`);

export interface Device {
  /**
   * The whole client, for `syncmeshReact` and nothing else.
   *
   * Screens never read this. They reach the procedures as `mesh.api.issues.list({…})`, the one
   * way both apps do, and the factory's hooks read `$status`, `$peers`, `$routes` and `$auth`
   * off it to draw the pill and the settings screen, and `$operations` to follow a write the
   * office may overrule. What stays here is what only a phone has: who is acting, whether they
   * chose, and the two buttons that change that.
   */
  readonly client: Client<typeof procedures, IssuesPresence>;
  /**
   * Whether this device holds a tombstone for a row: *deleted*, as against *never heard of*.
   *
   * Not a procedure, and it cannot be one. A row that stops being visible is deleted out of this
   * phone's SQLite outright, so every read above it — `issues.get` included — answers both cases
   * with the same empty result; the record that remembers the delete is the engine's, and
   * `mesh.deletedAt` is the door onto it.
   *
   * The boolean and not that call's `Stamp`, because the stamp names the **device** that deleted
   * the row and carries that device's clock. Neither is an account and neither is this phone's
   * wall time, so a screen handed the stamp could say nothing more with it than this says.
   */
  readonly deleted: (table: string, key: string) => boolean;
  /**
   * Who this device is acting as, and with what authority.
   *
   * Read from the database rather than compiled in, so "go in as Bo, as a guest" is a fact the
   * install holds rather than a build anyone has to make. {@link Device.signInAs} is how it moves.
   */
  readonly actor: Actor;
  /**
   * Whether a person has actually chosen, as opposed to this being the default nobody picked.
   *
   * The distinction is what the first launch turns on: `false` means the picker has never run, and
   * the app opens on it. Defaulting silently would make every fresh install Ada and hide the whole
   * feature behind a settings screen nobody would think to open.
   */
  readonly chosen: boolean;
  /**
   * Acts as somebody else from the next call onward.
   *
   * **A re-register, not a rebuild.** The grant registry is keyed by device and keeps whichever
   * grant is newest (`grant-registry.ts` compares `issuedAt`), so minting a fresh one for this
   * same device with a different account simply supersedes the old one — no engine restart, no
   * re-read of state, no resync. What the mesh signs with is unchanged, because the device key and
   * the account are two different facts and only the second one moved.
   */
  readonly signInAs: (actor: Actor) => Promise<void>;
  /** Forgets the choice, so the next launch asks again. The log and the device key are untouched. */
  readonly signOut: () => Promise<void>;
  readonly relay: string;
  /** Where this device is looking for its authority, for a settings screen to show plainly. */
  readonly authority: string;
  /** Whether this build got a radio — what the header badge says out loud. */
  readonly overTheAir: boolean;
  /** How much this device is holding, for reading a duration against the work it covered. */
  readonly scale: () => Promise<Scale>;
  /**
   * Throws the local replica away and restarts the app, so the next launch is a cold join.
   *
   * The log is the durable thing and it lives on the peers too, so deleting this copy loses
   * nothing that was acknowledged — it just makes this device new again, which is the only way to
   * measure a first sync more than once. Anything written here and not yet carried by anyone else
   * *is* lost, which is why this is a deliberate act behind a button and not a recovery path.
   */
  readonly reset: () => Promise<void>;
}

/**
 * The running mesh's own instruments, for the one screen whose job is to look at them.
 *
 * Deliberately **not** on {@link Device}. That interface is what every screen in this app is
 * handed, and a transport on it is a transport somebody eventually writes through — the narrowing
 * is the point, and widening it for one reader would give every other reader a door it should not
 * have. This is a second door with a name that says who it is for, and `app/devtools.tsx` is the
 * only thing that opens it.
 */
export interface Instruments {
  /**
   * Every medium currently attached — read fresh on each call rather than captured.
   *
   * `$transports.list()` follows the set, and the `media` array this module built does not: a
   * radio added at runtime would never reach a reading taken over the array. It is the same
   * reason `@syncmesh/devtools`' own `watchMediums` reconciles on every read.
   */
  readonly media: () => readonly Transport[];
  /** Per-source condition and the one overall health, exactly as `$status` folds them. */
  readonly status: () => MeshStatus;
  /**
   * Link-level endings since this mesh opened, newest first, bounded.
   *
   * Held here rather than subscribed by the screen, because `onLinkEvent` retains nothing by
   * design: a panel that starts listening when it is opened can only ever report the quiet that
   * follows, and the fact worth seeing — *the relay proved itself at launch and has said nothing
   * since* — happened minutes before anybody opened a panel.
   */
  readonly endings: () => readonly DevtoolsLinkEvent[];
  /**
   * The write ledger: what this device committed that no peer has receipted yet.
   *
   * `undefined` over a mesh with no operations store, which this app never builds — but the
   * surface says so rather than asserting, because the absence is a real one in the contract.
   */
  readonly writes: OperationsView | undefined;
}

/** The one file this replica lives in, named once because {@link Device.reset} deletes it. */
const DATABASE = "issues.db";

/**
 * The client behind {@link opening}, which is the thing that actually has to be stopped.
 *
 * `$close` is held here rather than read off {@link Device.client}, because the one caller that
 * stops the mesh is the module that opened it — a hot reload, a reset — and not a screen.
 * {@link Instruments} rides along for the same reason and with the same door.
 */
let live: { readonly $close: () => Promise<void>; readonly instruments: Instruments } | undefined;

/**
 * What the running mesh will say about itself, or `undefined` when none is running.
 *
 * The absence is real rather than defensive: between {@link Device.reset} and the relaunch that
 * follows it there is no mesh, and a devtools screen that drew zeroes there would be reporting a
 * silent mesh as a healthy empty one.
 */
export const meshInstruments = (): Instruments | undefined => live?.instruments;

/**
 * Opens this device's replica. **Call it once** — `openReplica` in `./open` is what guarantees that.
 *
 * Opening twice is not slow, it is wrong: two engines over one log stamp events below ones the
 * relay has already seen, and the loser's writes are dropped as already-seen rather than refused
 * (`research/browser-durability.md` §4). The memo lives a module away because this one is loaded
 * lazily, and a memo inside a lazily-loaded module is a memo per load.
 */
export const openMesh = (): Promise<Result<Device, MeshUnavailable>> => open();

/** Metro's per-module hot API, declared here because this file is the only one that wants it. */
declare const module: { readonly hot?: { readonly dispose: (run: () => void) => void } };

/**
 * The replica this module used to hold, released when Fast Refresh replaces the module.
 *
 * Editing this file re-evaluates it, and `opening` starts out empty again — but the mesh it held a
 * moment ago is still running: a socket that still receives, heartbeats that still fire, an engine
 * still folding into the same database. Nothing points at it and nothing stops it. Twenty edits in
 * an afternoon leave twenty of them on the one thread that draws, and the symptom is not an error
 * but an app that grows steadily worse over a session and is fine again after a cold start — which
 * is exactly how it was found.
 *
 * A module that memoises something live owes the runtime a way to let go of it, and this is that.
 * `module.hot` exists only in a development bundle, so the guard is the whole of the production
 * story: there, this file is evaluated once and the replica lives as long as the app does.
 */
module.hot?.dispose(() => {
  const stopping = live;
  live = undefined;
  void stopping?.$close();
});

/**
 * The last reasons the radio dropped a link, newest first.
 *
 * Module-level and bounded, for the same reason the link-event ring is: a panel opened after the
 * fact can only show what something was already keeping. Twenty is enough to see a pattern and few
 * enough that a phone in a bad radio environment does not grow a leak.
 */
export const bleDropped: { readonly at: number; readonly why: string }[] = [];

const open = (): Promise<Result<Device, MeshUnavailable>> =>
  Result.gen(async function* () {
    if (MEASURING) watchSql();
    const driver = expoSqliteDriver(DATABASE);

    // the device key is minted once and read back out of the database beside the log it signs, so
    // a reinstall is a new author and a relaunch is the same one
    const device = yield* (await deviceIdentity(driver)).mapError(
      (cause) =>
        new MeshUnavailable({ message: "this install's device key would not open", cause }),
    );
    /**
     * Why the radio gave up on a link, said out loud.
     *
     * **This used to be `const dropped: string[] = []` — pushed to and never read once.** Every
     * reason BLE had for dropping a peer went into an array nobody looked at, which is how two
     * phones can sit a foot apart reporting "Bluetooth is present" and "has said nothing since app
     * launched" with no way to find out why. A reason nothing consumes is a reason that may as
     * well not have been produced.
     */
    const over = bleOverAir(
      (why) => {
        bleDropped.unshift({ at: Date.now(), why });
        if (bleDropped.length > 20) bleDropped.pop();
        // eslint-disable-next-line no-console -- the radio has no other way to say this on a phone
        console.log("[ble] dropped:", why);
      },
      reportSightings(String(device.peerId)),
    );
    /**
     * The bulk lane, where the platform has one.
     *
     * Beside BLE rather than instead of it: the route scorer reads the bandwidth each medium
     * declares and sends a snapshot down the wide one and a heartbeat down the narrow one, and
     * peer sessions fold several links to one device into one conversation. A phone with neither
     * radio simply has fewer sources, which `$status` already knows how to say.
     */
    const overWifi = wifiOverAir((why) => {
      // eslint-disable-next-line no-console -- the radio has no other way to say this on a phone
      console.log("[wifi] dropped:", why);
    });
    const app = yield* await Result.tryPromise({
      try: async () => {
        const opened = createClient({
          schema: issuesSchema(),
          procedures,
          identity: device,
          trust: { issuer: issuer.peerId, authority: authority.peerId },
          storage: sqlite({ driver }),
          /**
           * Two media, and the order is not a preference.
           *
           * Both are *sources* behind this device's own database rather than in front of it: a
           * read is answered locally either way, and what a transport changes is only how quickly
           * somebody else's write arrives. The relay is the one that reaches a laptop across the
           * network; BLE is the one that reaches the phone on the other side of the table with no
           * network at all, which is the case the rest of this system exists for. A medium that
           * cannot start — a simulator with no radio, a build with no native module — is one fewer
           * source and not a failure; `$status` reports the condition per source and the app keeps
           * working out of its own log.
           */
          transports: [
            relayTransport({ dial: webSocketDial(RELAY_URL) }),
            ...(over === undefined ? [] : [over]),
            ...overWifi.transports,
          ],
          /**
           * The two signals this platform has that mean *look at your links again*.
           *
           * Recovery used to be written out here — an `AppState` listener, a reachability
           * listener, and a loop calling `wake()` over the media — which made it this app's
           * problem and would have made it every other app's problem too. It is the library's
           * now: these two say the world may have moved, and each medium decides what that means
           * for its own link. Nothing in this file has to remember to unsubscribe them.
           */
          knocks: [foreground(), reachability()],
          link: httpLink(AUTHORITY_URL),
        });
        await opened.$ready;
        return opened;
      },
      catch: because("the mesh could not open over the database"),
    });
    /**
     * Every ending this mesh has reported, kept from the moment it opened.
     *
     * The library's ring rather than one written out here. This used to be a local array with a
     * comment explaining that `createLinkRing` could not be imported, because `@syncmesh/devtools`
     * put the DOM in its root entry; that entry is split now, so the copy has no reason to exist.
     * Forty rather than the library's default 200: this is read on a phone screen, and the shape
     * of a reconnect storm is legible well before the two-hundredth ending.
     *
     * It also fixes something the copy got wrong. A row keyed by array index silently becomes a
     * different ending under a reader who has not scrolled, because position is not identity —
     * `recent()` carries an `id` that never repeats.
     */
    const endings = createLinkRing(40);
    const offEndings = app.$transports.onLinkEvent(endings.note);
    /**
     * The same facts, in the log rather than in a panel — see `./link-log.ts` for why both.
     *
     * A panel shows this device. The failure worth diagnosing is between two of them, and two
     * phones attached to one Metro put their lines in one file.
     */
    const offLinkLog = watchLinks(app, String(device.peerId));
    /**
     * What this module subscribed on the mesh's behalf, let go in one place.
     *
     * Two callers — {@link Device.reset} and the Fast Refresh disposer — and a subscription that
     * one of them forgot is a hub that keeps a dead closure alive across every edit in a session,
     * which is the exact failure `module.hot.dispose` below was added to stop.
     */
    const release = (): void => {
      offEndings();
      offLinkLog();
      overWifi.release();
    };
    live = {
      $close: async () => {
        release();
        await app.$close();
      },
      instruments: {
        media: app.$transports.list,
        status: app.$status.get,
        endings: endings.recent,
        writes: app.$operations,
      },
    };
    /**
     * Who this install last chose, and whether it has ever been asked.
     *
     * A read that *fails* is not the same as one that comes back empty, and neither is fatal: the
     * app can still open as the default and say so. `chosen` carries the difference to the UI,
     * which is what decides whether the first screen is the list or the picker.
     */
    const remembered = (await storedActor(driver)).unwrapOr(undefined);
    let acting = remembered ?? DEFAULT_ACTOR;

    const grant = (actor: Actor) =>
      app.$grants
        .register(actorGrant(issuer, { actor, device: device.peerId }))
        .mapError(because("the device's own grant would not register"));

    yield* grant(acting);
    const scale = async (): Promise<Scale> => {
      const [events] = await driver.all(
        "SELECT count(*) AS n, sum(length(core)) AS b FROM events",
        [],
      );
      const [rows] = await driver.all("SELECT count(*) AS n FROM state_rows", []);
      return {
        events: Count.parse(events?.[0]),
        bytes: Count.parse(events?.[1]),
        rows: Count.parse(rows?.[0]),
      };
    };

    const reset = async (): Promise<void> => {
      // stopped before it is deleted: the engine holds this file open, and a database removed from
      // under a live connection is a corrupt one rather than an absent one
      release();
      await app.$close();
      // `$close` stops the mesh but leaves this connection open on purpose — "a driver you passed
      // stays yours to close" (`client/src/boot.ts`) — and a database with a live handle on it
      // cannot be deleted, so the close that matters here is this one
      await driver.close?.();
      live = undefined;
      // nothing to forget here: `DevSettings.reload` restarts the runtime, and every module's
      // state — the memo in `./open` included — goes with it
      const gone = await Result.tryPromise({
        try: () => deleteDatabaseAsync(DATABASE),
        catch: (cause) => cause,
      });
      // eslint-disable-next-line no-console -- a reset that silently did nothing is the worst case
      console.log("[reset]", gone.isOk() ? "database deleted" : `refused: ${String(gone.error)}`);
      DevSettings.reload("the local replica was reset");
    };

    /**
     * Acting as somebody else, written down first and registered second.
     *
     * The order matters on a crash: an install that registered a grant it had not recorded would
     * come back as whoever it was before, having already made writes under the new name. Recording
     * first means the worst case is an install that knows who it is and re-registers on next boot,
     * which is what boot does anyway.
     */
    const signInAs = async (next: Actor): Promise<void> => {
      const written = await rememberActor(driver, next);
      if (written.isErr()) throw written.error;
      const registered = grant(next);
      if (registered.isErr()) throw registered.error;
      acting = next;
    };

    const signOut = async (): Promise<void> => {
      const forgotten = await forgetActor(driver);
      if (forgotten.isErr()) throw forgotten.error;
    };

    return Result.ok({
      client: app,
      deleted: (table: string, key: string) => app.$mesh.deletedAt(table, key) !== undefined,
      // a getter, because `acting` moves under {@link signInAs} and a copied field would not
      get actor() {
        return acting;
      },
      authority: AUTHORITY_URL,
      chosen: remembered !== undefined,
      overTheAir: over !== undefined,
      relay: RELAY_URL,
      reset,
      scale,
      signInAs,
      signOut,
    });
  });
