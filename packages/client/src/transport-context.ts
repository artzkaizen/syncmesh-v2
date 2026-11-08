import type { PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { AdmissionAsk, RouteTable, TransportContext } from "@syncmesh/transport";
import type { KeyRing } from "@syncmesh/wire";

import { kindOf } from "@syncmesh/kernel";
import { omitUndefined } from "@syncmesh/result";
import {
  createAdmissionGate,
  createPeerSessions,
  createReadGate,
  createRouteTable,
  oneSeatPerPeer,
} from "@syncmesh/transport";
import { createKeyRing } from "@syncmesh/wire";

import type { MeshShaping } from "./transports.js";

/**
 * The sealed partitions a device can read (book ch. 14). Keys arrive the one way they can —
 * inside a verified grant addressed to this device — so the registry is the only feed, and a
 * device that never receives one carries every sealed event whole and reads none of it.
 */
export function keyRingFor(
  identity: TransportContext["identity"],
  grants: TransportContext["grants"],
): KeyRing {
  const keys = createKeyRing(identity);
  for (const grant of grants.all()) keys.learn(grant);
  grants.onRegistered((grant) => keys.learn(grant));
  return keys;
}

/**
 * The context every transport on this device starts with, and the two tables it shares.
 *
 * Both are the device's rather than any one medium's: a route learned over BLE is one the access
 * point may advertise, and a peer reachable on two media is one conversation. Built here rather
 * than in the mesh so that what a transport is handed has one owner.
 */
export function transportContextFor(base: {
  readonly engine: TransportContext["engine"];
  readonly identity: TransportContext["identity"];
  readonly grants: TransportContext["grants"];
  readonly now: () => Temporal.Instant;
  readonly onPresence: NonNullable<TransportContext["onPresence"]>;
  /** A join completed somewhere (RFC-0019); what `$recovery.rebuild` waits on. */
  readonly onSnapshot: NonNullable<TransportContext["onSnapshot"]>;
  readonly onGrantRequest?: TransportContext["onGrantRequest"];
  /** This device's storage lineage, so what it holds can be signed for (D28). */
  readonly incarnation?: TransportContext["incarnation"];
  /** Where a peer's signed custody of this device's own writes lands (D28). */
  readonly onReceipt?: TransportContext["onReceipt"];
  /** Where a peer's signed refusal of this device's own writes lands (D32). */
  readonly onRefusal?: TransportContext["onRefusal"];
  /** This device answers for the authority itself; every other learns the way to one. */
  readonly servesAuthority: boolean;
  /** What this device can read of the sealed partitions (book ch. 14). */
  readonly keys: KeyRing;
  /** Our own partitions, for the door's grant-derived default. */
  readonly partitions: () => readonly string[];
  /** How this device shapes its part of the mesh, including who may form a link at all. */
  readonly shaping?: MeshShaping;
  /**
   * The issuer of a granted mesh, which turns on the read gate (D40): every link then sends a
   * peer only what its verified grant covers. Absent, the mesh is ungranted and links carry all.
   */
  readonly issuer?: PeerId;
  /** The kinds whose content is sealed, which a link may carry to a peer that cannot read them. */
  readonly sealedKinds?: ReadonlySet<string>;
  /** The authority-visibility tables (D24), which no peer-to-peer link here carries. */
  readonly withheld?: TransportContext["withheld"];
}): TransportContext & { readonly routes: RouteTable } {
  const routes = createRouteTable({ self: base.identity.peerId, now: base.now });
  if (base.servesAuthority) routes.serve("authority");
  /**
   * The door (book ch. 14). It needs no configuration to be useful: the grant is this door too,
   * so a peer holding one that overlaps our partitions is worth a handshake and everyone else is
   * a stranger whose slot, battery and handshake we keep.
   */
  const gate = createAdmissionGate({
    grants: base.grants,
    partitions: base.partitions,
    ...omitUndefined({ group: base.shaping?.group, handler: base.shaping?.admit }),
  });
  const sessions = createPeerSessions();
  const context = {
    engine: base.engine,
    identity: base.identity,
    grants: base.grants,
    routes,
    sessions,
    crypto: base.keys.crypto(),
    admits: oneSeatPerPeer(
      // the ask's own rung wins: spreading it *under* a fixed `proven` — which is what this did —
      // silently promoted every cheap dial-rung question to the strict one, so the ladder had two
      // rungs in `gate.ts` and one everywhere it was actually asked
      async (ask: AdmissionAsk) => (await gate.admit({ stage: "proven", ...ask })) === "allow",
      (peer) => sessions.get(peer) !== undefined,
    ),
    now: base.now,
    onPresence: base.onPresence,
    onSnapshot: base.onSnapshot,
  };
  if (base.onGrantRequest !== undefined)
    Object.assign(context, { onGrantRequest: base.onGrantRequest });
  if (base.incarnation !== undefined) Object.assign(context, { incarnation: base.incarnation });
  if (base.onReceipt !== undefined) Object.assign(context, { onReceipt: base.onReceipt });
  if (base.onRefusal !== undefined) Object.assign(context, { onRefusal: base.onRefusal });
  if (base.withheld !== undefined) Object.assign(context, { withheld: base.withheld });
  if (base.issuer !== undefined) {
    const sealedKinds = base.sealedKinds ?? new Set<string>();
    const readGate = createReadGate({
      grants: base.grants,
      self: base.identity.peerId,
      issuer: base.issuer,
      sealed: (partition) => sealedKinds.has(kindOf(partition)),
    });
    Object.assign(context, { readGate });
  }
  return context;
}
