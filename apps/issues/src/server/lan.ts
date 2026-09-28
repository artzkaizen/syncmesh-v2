import { nodeLan } from "@syncmesh/lan-node";
import { createClient, sqlite } from "@syncmesh/orpc";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { lan } from "@syncmesh/transports";
import { createIdentity } from "@syncmesh/wire";
import { mkdirSync } from "node:fs";

import { actorGrant } from "../actor.js";
import { AUTHORITY_PEER, issuer } from "../app/identity.js";
import { WORKSPACE, WORKSPACE_ID } from "../domain.js";
import { procedures } from "../procedures.js";
import { issuesSchema } from "../schema.js";
import { seedWorkspace } from "../seed.js";

/**
 * A device in the room, with no relay and no internet — `bun run --cwd apps/issues lan <name>`.
 *
 * The same transport the phone runs, over Node's sockets instead of Swift's. That is the whole
 * value of it: `packages/transports/src/lan` is runtime-neutral by rule (D01-B), so the code that
 * decides who announces, who dials, and what an announcement means is byte-for-byte the code in
 * the iOS build — only `LanNetwork` differs, `dgram`/`net` here and `NWListener` there.
 *
 * So this answers two questions the simulator cannot:
 *
 * 1. **Does the LAN transport work on a real network at all?** The unit tests run it over a
 *    virtual network, and `adapters/lan-node` runs it over the loopback with multicast *off* —
 *    because whether an access point forwards multicast between its clients is a fact about the
 *    room, not about this code. Two of these on the actual Wi-Fi is the first time that fact gets
 *    tested, and `--peer` is the answer when it turns out to be no.
 * 2. **Does the phone's LAN transport work?** This node is a peer of it. The room name, the
 *    schema, and the issuer are the same three constants the native build uses, so a laptop
 *    running this and a phone running the app are two devices in one mesh — which means the
 *    native side can be tested with one phone instead of two.
 *
 * It is not a relay. It holds the whole room the way every device does, decides nothing, and if
 * you stop it the other devices keep working; `apps/issues/src/server/relay.ts` is the node that
 * is always on, and the difference is that this one is a peer.
 */

/** The room. The string the native build names in `apps/issues-native/src/wifi.ts`, and nothing else. */
const ROOM = Bun.env["ROOM"] ?? "issues";

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const present = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * Who this process is. Named rather than generated, so a restart is the same author picking up
 * where it left off — a fresh key every run turns one device's log into a crowd of strangers.
 *
 * Two processes must not share a name, for the same reason inverted: one author publishing two
 * divergent `(author, seq)` streams into one log loses whichever arrives second, silently.
 */
const who = process.argv[2]?.startsWith("--") === false ? process.argv[2] : "laptop";
const account = `acct_${who}`;

/** A stable 32-byte seed from the name. Demo keys, exactly as `app/identity.ts` says of its own. */
const seedOf = (name: string): Uint8Array => {
  const hash = new Bun.CryptoHasher("sha256").update(`syncmesh:lan:${name}`).digest();
  return new Uint8Array(hash);
};

const device = createIdentity(seedOf(who)).unwrap();
const short = device.peerId.slice(0, 8);
const say = (line: string): void => void process.stdout.write(`${line}\n`);

mkdirSync(".syncmesh", { recursive: true });

/**
 * Where announcements go when the group does not carry them.
 *
 * Managed access points — every café, most offices, a lot of home mesh kit — drop multicast
 * between clients. On those networks the group is silence rather than an error, and there is no
 * way to tell the two apart from inside: nobody answering looks identical either way. So the
 * unicast path is a flag a person sets after watching the group stay quiet, and the node prints
 * its own discovery address on boot so the other end has something to be pointed at.
 *
 * `--discovery <port>` fixes where this node listens for them, which is what makes two nodes
 * pointable at each other without either having started first.
 */
const seeds = (flag("peer") ?? "")
  .split(",")
  .filter((one) => one.length > 0)
  .map((one) => {
    const [host = "", port = ""] = one.split(":");
    return { host, port: Number(port) };
  });

const listensOn = flag("discovery");

const sockets = {
  multicast: !present("no-multicast"),
  onDropped: (why: string) => say(`[lan] ${short} · dropped: ${why}`),
  seeds: () => seeds,
};

const network = (
  await nodeLan(
    listensOn === undefined ? sockets : { ...sockets, discoveryPort: Number(listensOn) },
  )
).unwrap();

const client = createClient({
  schema: issuesSchema(),
  procedures,
  identity: device,
  trust: { authority: AUTHORITY_PEER, issuer: issuer.peerId },
  storage: sqlite({ driver: bunSqliteDriver(`.syncmesh/lan-${who}.db`) }),
  transports: [
    lan({
      id: ROOM,
      name: "issues-lan",
      network,
      onDropped: (why) => say(`[lan] ${short} · dropped: ${why}`),
    }),
  ],
});
await client.$ready;

/**
 * A grant for this node, **and one for every name this demo knows** — because the door will not
 * admit a peer this device holds no grant for, at either rung.
 *
 * That is worth stating plainly, because it is the property that explains the whole of BLE's
 * behaviour on the phones: a grant arrives as data, and the bridge trades grants only *after* a
 * link is admitted, so two devices that have never met through a relay do not link over any
 * radio. They see each other, they handshake, the door denies, the link closes, and the next
 * announcement tries again. `AdmissionAsk.requesting` is the corridor meant for this and nothing
 * sets it yet.
 *
 * So this node does what a deployment's authority would have done before either device left the
 * building: it mints the grants. It can, because the issuer's private half is in this bundle —
 * the shortcut `app/identity.ts` documents at length, and `--introduce` is the flag that performs
 * it. Drop a name from that list and you have the unintroduced case, on purpose.
 */
for (const name of [who, ...(flag("introduce") ?? "").split(",")].filter((one) => one.length > 0))
  client.$grants
    .register(
      actorGrant(issuer, {
        actor: { account: `acct_${name}`, role: "admin" },
        device: createIdentity(seedOf(name)).unwrap().peerId,
      }),
    )
    .unwrap();

say(`[lan] ${short} · ${who} · room "${ROOM}" · links on :${String(network.address().port)}`);
say(
  `[lan] ${short} · announcements on ${network.discoveryAddress().host}:${String(network.discoveryAddress().port)} — the other node's --peer`,
);

/**
 * Every link event, because the failure this exists to find is *between* two processes and the
 * standing picture below only ever shows one of them. A pair that never prints `proven` has a
 * discovery or a dial problem; a pair that prints it and never moves `theirs` has a link that
 * formed and carried nothing, and those are two different bugs in two different files.
 */
client.$transports.onLinkEvent((event) => {
  const who = event.peer === undefined ? "" : ` peer=${String(event.peer).slice(0, 8)}`;
  const why = event.why === undefined ? "" : ` why=${event.why}`;
  say(`[link] ${short} · ${event.transport} ${event.kind}${who}${why}`);
});

/**
 * What this device has taken in, split the only way that tells a broken link from a quiet one.
 *
 * `theirs` staying at zero while the other node writes is a delivery failure. `theirs` moving
 * while nothing appears below is a different bug in a different file, and `parked` is which.
 */
let mine = 0;
let theirs = 0;
let parked = 0;
client.$mesh.engine.onFoldBatch((batch) => {
  if (batch.source === "local") mine += batch.eventCount;
  else theirs += batch.eventCount;
});
client.$mesh.engine.onQuarantine(({ event, reason }) => {
  parked += 1;
  say(
    `[parked] ${short} · from ${String(event.peerId).slice(0, 8)} ${String(event.procedure)} why=${reason._tag}`,
  );
});

/** The standing picture, printed only when it differs from the last — a quiet mesh is quiet here too. */
let last = "";
const picture = (): void => {
  const sources = [...client.$status.get().sources].map(([name, source]) => {
    const reaches = client.$transports
      .list()
      .find((one) => one.name === name)
      ?.reaches?.().size;
    return `${name} ${source.condition}${reaches === undefined ? "" : ` reaches ${String(reaches)}`}`;
  });
  const line = `${sources.join(" · ")} · folded ${String(mine)} mine / ${String(theirs)} theirs · parked ${String(parked)}`;
  if (line === last) return;
  last = line;
  say(`[mesh] ${short} · ${line}`);
};
const ticking = setInterval(picture, 2000);

/** Every issue in the workspace, maintained — what a screen would subscribe to, printed instead. */
const live = client.issues.list({ limit: 200, workspaceId: WORKSPACE_ID })["~mesh"].live();
const known = new Set<string>();
let first = true;
live.subscribe((rows) => {
  const fresh = rows.filter((row) => !known.has(row.id));
  for (const row of rows) known.add(row.id);
  if (first) {
    first = false;
    say(`[rows] ${short} · ${String(rows.length)} issues on this device`);
    return;
  }
  for (const row of fresh) say(`[rows] ${short} · + ${row.title}`);
});
await live.ready;

const teamOf = async (): Promise<string | undefined> =>
  (await client.teams.list({ workspaceId: WORKSPACE_ID })).unwrap().data[0]?.id;

if (present("seed") && (await teamOf()) === undefined) {
  const made = await seedWorkspace(client.$mesh.on(WORKSPACE).unwrap().db, {
    as: account,
    issues: Number(flag("issues") ?? 6),
  });
  say(`[seed] ${short} · ${String(made.issueIds.length)} issues in ${String(made.teamIds.ENG)}`);
}

say(`[lan] ${short} · type a title and press enter to file an issue; /quit to stop`);

const stop = async (): Promise<void> => {
  clearInterval(ticking);
  live.release();
  await client.$close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

for await (const line of console) {
  const title = line.trim();
  if (title.length === 0) continue;
  if (title === "/quit") break;
  const teamId = await teamOf();
  if (teamId === undefined) {
    say(`[lan] ${short} · no team here yet — start one node with --seed, or wait for it to arrive`);
    continue;
  }
  await client.issues.create({ actorId: account, teamId, title, workspaceId: WORKSPACE_ID })
    .committed;
  say(`[rows] ${short} · filed "${title}"`);
}
await stop();
