import type { Transport } from "@syncmesh/transport";

import { createClient, sqlite } from "@syncmesh/orpc";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createFrameTransport, loopbackPair } from "@syncmesh/transport";
import { createIdentity, issueGrant } from "@syncmesh/wire";

import { procedures } from "./api.js";
import { PRACTICE, roundsSchema } from "./schema.js";

/**
 * Two phones on a ward with no signal, over an in-process radio.
 *
 * Run: `bun run --cwd examples rounds`
 */

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
const issuer = createIdentity(seed(1)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/** Each end of a loopback as a `Transport`, which is all a mesh needs from a medium. */
const pair = () => {
  const { a, b, control } = loopbackPair();
  const end = (link: typeof a): Transport =>
    createFrameTransport({ name: "loopback", open: (_ctx, attach) => void attach(link) });
  return { a: end(a), b: end(b), control };
};

const staff = {
  ann: createIdentity(seed(60)).unwrap(),
  raj: createIdentity(seed(120)).unwrap(),
};

/**
 * Everyone's grant, on every device. A receiver admits an author it can vouch for, so a phone
 * that has never heard of the clinician at the next bed quarantines her readings — which is the
 * whole point of the ladder, and the thing a real onboarding flow (`mesh.requestGrant`) carries
 * over the link instead of a script handing them out.
 */
const grants = Object.entries(staff).map(([name, who]) =>
  issueGrant(issuer, {
    account: `acct_${name}`,
    device: who.peerId,
    role: "clinician",
    // SAFETY: the ward this demo runs under, in the documented kind:id form
    partitions: [PRACTICE] as never,
    validFor: Temporal.Duration.from({ hours: 8 }),
    now: T0,
  }),
);

const device = async (name: keyof typeof staff, transport: Transport) => {
  const app = await createClient({
    schema: roundsSchema(),
    procedures,
    identity: staff[name],
    trust: { issuer: issuer.peerId },
    storage: sqlite({ driver: bunSqliteDriver(":memory:") }), // a fresh ward every run
    transports: [transport],
    now: () => T0,
  });
  for (const grant of grants) app.$grants.register(grant).unwrap();
  return app;
};

const links = pair();
const ann = await device("ann", links.a);
const raj = await device("raj", links.b);
const settle = async () => {
  for (let round = 0; round < 12; round += 1) {
    await links.control.flush();
    await ann.$mesh.flush();
    await raj.$mesh.flush();
  }
};

// Ann admits a patient and takes a reading. Every call is `api.*`; no handle, no SQL.
(await ann.patients.admit({ id: "p1", name: "J. Okonkwo", bed: "4B" }).committed).unwrap();
const first = (
  await ann.observations.record({
    patientId: "p1",
    code: "BP",
    value: "128/84",
    takenAt: Date.now(),
    author: "ann",
  }).committed
).unwrap();

await settle();

// Raj, on the other phone, already has both — nothing was fetched.
const onRaj = await raj.observations.forPatient({ patientId: "p1" }).run();
console.log("raj sees:", onRaj.map((o) => `${o.code} ${o.value}`).join(", "));

// The radio goes down. Both keep writing.
links.control.setOnline(false);
const offline = (
  await raj.observations.record({
    patientId: "p1",
    code: "HR",
    value: "88",
    takenAt: Date.now(),
    author: "raj",
  }).committed
).unwrap();
(
  await ann.observations.amend({ amends: first.data.id, value: "126/82", author: "ann" }).committed
).unwrap();

const reachOf = async (id: string) => (await raj.observations.reach({ id }).run())[0]?.sync;
console.log("raj's reading while offline:", await reachOf(offline.data.id));

// the radio is back. A link that dropped frames while it was down asks from its last
// contiguous position — the same thing a phone does when it walks back into range.
links.control.setOnline(true);
links.a.resync?.();
links.b.resync?.();
await settle();

// Both survive: the amendment is a new row naming the one it replaces, not an edit.
for (const [who, side] of [
  ["ann", ann],
  ["raj", raj],
] as const) {
  const rows = await side.observations.forPatient({ patientId: "p1" }).run();
  console.log(
    `${who}:`,
    rows.map((o) => `${o.code}=${o.value}${o.amends === null ? "" : " (amends)"}`).join(" | "),
  );
}
console.log("raj's reading after reconnect:", await reachOf(offline.data.id));

await ann.$mesh.stop();
await raj.$mesh.stop();
