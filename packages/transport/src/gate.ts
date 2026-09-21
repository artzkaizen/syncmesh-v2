import type { JsonValue, PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { GrantRegistry } from "@syncmesh/wire";

/**
 * Whether a link forms at all (book ch. 14) — the door, as opposed to the budget, which decides
 * which of the links that did form are worth keeping.
 *
 * Needs no configuration, because the grant is this door too: a peer that proves a grant
 * overlapping our partitions is worth a handshake, a peer asking for one has to be able to ask,
 * and everyone else is a stranger whose slot, battery and handshake we keep. That default alone
 * answers the lobby: the other company's phones hold no overlapping grant, so they get no link.
 */

export interface AdmissionAsk {
  /**
   * Who this is about.
   *
   * At the `dial` rung it is what an announcement **claimed** — a lossy BLE hint, a datagram
   * anyone can send, whatever a peer published as service information. At the `proven` rung the
   * handshake has signed for it. A policy that must be right reads `stage` before it reads this.
   */
  readonly peer: PeerId;
  readonly transport: string;
  /** The group the far peer announced, when the medium carries one. */
  readonly group?: string;
  /** The peer is asking for a grant rather than presenting one — the one corridor a stranger has. */
  readonly requesting?: boolean;
  /** Which rung of the way in this is; absent reads as `proven`, the rung that has the facts. */
  readonly stage?: AdmissionStage;
  /** Self-asserted, and never a security input: cosmetics, and what a deny-despite-grant may read. */
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type Admission = "allow" | "deny";

/**
 * Where on the way in this ask sits (libp2p's `ConnectionGater` ladder, condensed to the two
 * rungs this system has facts at).
 *
 * **`dial`** — before a dial is spent. All that is known is what the medium announced, so this
 * is the cheap refusal: it saves a handshake, a radio slot and a socket against a peer we are
 * not going to keep. Being wrong here costs a link that a later sighting re-offers.
 *
 * **`proven`** — the handshake has named the peer and signed for it. This is the rung a policy
 * that matters belongs on, and the only one whose `peer` is a fact.
 *
 * A gate asked at one rung and not the other is normal: the grant-derived default answers both,
 * and a handler that only cares who a peer really is need only look at `proven`.
 */
export type AdmissionStage = "dial" | "proven";

/**
 * An override for what membership cannot express — policies about the **radio**, not about who
 * belongs: "no BLE links inside this facility", "battery under 10%, keep the server link only",
 * or quarantining a suspect device topologically **now**, while its revocation is still
 * propagating as data.
 *
 * It is an override of the grant-derived default, never a second trust system. Its one trusted
 * input is the grant's own vouched claims; an allowed connection still grants no data access,
 * because the fold checks every event against the same rules either way.
 */
export type AdmissionHandler = (
  ask: AdmissionAsk & {
    /** What the issuer signed about this peer — the only channel a security decision may read. */
    readonly vouched: Readonly<Record<string, JsonValue>>;
  },
) => Promise<Admission> | Admission;

export interface GateOptions {
  readonly grants: GrantRegistry;
  /** Our own partitions; a peer sharing none of them can tell us nothing. */
  readonly partitions: () => readonly string[];
  /**
   * Segments fleets that share an app but should not auto-connect — a depot's vans and a
   * warehouse's scanners running the same build.
   *
   * **An optimization, not a security control.** A dial-out bypasses it entirely, and anything
   * that reaches a link still faces the grant and the `allow` rules; data isolation comes from
   * those and from nothing here. It saves handshakes and radio slots, which is worth having and
   * is all it is.
   */
  readonly group?: string;
  readonly handler?: AdmissionHandler;
  /** How long the handler may take before the gate answers for it. Default 2 seconds. */
  readonly within?: Temporal.Duration;
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Three properties, all of them load-bearing:
 *
 * - **Fails closed.** A handler that throws, or takes longer than its deadline, denies. A gate
 *   that let a peer in because its policy code was slow is not a gate.
 * - **Deny is retry-after-backoff**, never a permanent verdict: a policy change or a grant that
 *   lands a moment later heals the mesh with no rendezvous.
 * - **Shapes topology only.** Allowing a connection grants no data access, and no gate can
 *   bypass a grant or an `allow` rule.
 */
export function createAdmissionGate(options: GateOptions) {
  const { grants, partitions, handler } = options;
  const timeoutMs = options.within?.total({ unit: "milliseconds" }) ?? DEFAULT_TIMEOUT_MS;

  /** The grant-derived default: overlap, or the corridor to ask for one. */
  const byGrant = (ask: AdmissionAsk): Admission => {
    // forced, because a joining device must be able to ask before it holds anything
    if (ask.requesting === true) return "allow";
    // a different fleet is not a threat, merely not ours to spend a radio slot on
    if (options.group !== undefined && ask.group !== undefined && ask.group !== options.group)
      return "deny";
    const held = grants.grantFor(ask.peer);
    /**
     * **A peer this device holds no grant for is refused at both rungs, which means first contact
     * over a radio needs an introduction that did not come over that radio.**
     *
     * Said here because it is a property of the whole system and this is the line that has it. A
     * grant arrives as data — from an authority, or folded from a mesh this device is already on —
     * and the bridge exchanges grants only *after* the door has admitted the link. So two devices
     * that have never met through a relay do not link over the local network, Wi-Fi or BLE either:
     * the handshake completes, this denies, the link closes, and the next announcement tries again.
     *
     * That is today's design rather than an oversight — {@link AdmissionAsk.requesting} is the
     * corridor meant for it, and nothing sets it yet. Until something does, an offline-first pair
     * has to be introduced while it is online at least once.
     */
    if (held === undefined) return "deny";
    const ours = new Set(partitions());
    return held.partitions.some((partition) => ours.has(String(partition))) ? "allow" : "deny";
  };

  return {
    admit: async (ask: AdmissionAsk): Promise<Admission> => {
      const derived = byGrant(ask);
      if (handler === undefined) return derived;
      const vouched = grants.grantFor(ask.peer)?.claims ?? {};
      const deadline = new Promise<Admission>((resolve) =>
        setTimeout(() => resolve("deny"), timeoutMs),
      );
      const asked = Promise.resolve()
        .then(() => handler({ ...ask, vouched }))
        .catch(() => "deny" as const);
      const verdict = await Promise.race([asked, deadline]);
      // the handler may only ever tighten: it overrides an allow, never manufactures one
      return verdict === "allow" ? derived : "deny";
    },
  };
}

/**
 * One decision per peer, however many media reach it at once.
 *
 * Two things make a second ask wrong, and they are different things. A peer **already in
 * conversation** was admitted when that conversation opened, and asking again would let a later
 * answer contradict the one the mesh is already acting on. A peer whose ask is **still in
 * flight** is the race: a device reachable over the access point and over a radio finishes both
 * handshakes within a millisecond of each other, neither has a session yet, and without this
 * both spend a trip through whatever policy an operator wrote.
 *
 * A peer with no conversation and no ask outstanding **is** asked again, deliberately: a denial
 * is retry-after-backoff and never a verdict, so the next sighting is a fresh attempt rather
 * than a sentence already passed.
 */
export const oneSeatPerPeer = (
  admits: (ask: AdmissionAsk) => Promise<boolean>,
  inConversation: (peer: PeerId) => boolean,
): ((ask: AdmissionAsk) => Promise<boolean>) => {
  const asking = new Map<PeerId, Promise<boolean>>();
  return async (ask) => {
    if (inConversation(ask.peer)) return true;
    const held = asking.get(ask.peer);
    if (held !== undefined) return held;
    const answer = admits(ask).finally(() => void asking.delete(ask.peer));
    asking.set(ask.peer, answer);
    return answer;
  };
};
