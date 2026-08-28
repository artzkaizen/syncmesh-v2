/**
 * Who gets in, split the way automerge-repo's share policy splits it: **announce** — may a name
 * nobody told us about become a room at all — separate from **access**, the operator's word on
 * one request for one room. Two questions because they have different answers: a relay can be
 * happy to serve the rooms it was told about while refusing to invent new ones on a stranger's
 * say-so, and no single predicate can say that.
 *
 * None of this is confidentiality. The relay holds no keys and reads no payloads, so a posture
 * decides who may open a socket, never what the bytes on it mean (RFC-0017).
 */
export interface RelayPosture {
  /**
   * Origins allowed to upgrade. Absent admits every origin, which is today's default and the
   * only honest one for a relay with non-browser clients.
   */
  readonly allowedOrigins?: readonly string[];
  /** Rooms this relay was told about, by the name their path carries; `/` names `main`. */
  readonly rooms?: readonly string[];
  /**
   * Whether a name nobody registered becomes a room. Default `true` — any path opens a log.
   * `false` is the server mode: it serves `rooms` and refuses the rest.
   *
   * A `rooms` list with `announce` left on restricts nothing. The two are one setting stated in
   * two halves on purpose: a list that silently became a firewall the first time somebody added
   * an entry to it is exactly the surprise a security posture must not spring.
   */
  readonly announce?: boolean;
  /**
   * Access: the last word on one upgrade, with the request in hand — a cookie, a bearer token,
   * a signed room ticket. Refusal is a 403 before any socket exists, so a rejected client never
   * costs the room a connection.
   */
  readonly verifyJoin?: (request: Request, room: string) => boolean | Promise<boolean>;
}

/** The posture as the questions one upgrade has to pass, in the order they get cheaper to fail. */
export interface RoomAccess {
  /**
   * `origin` is what the client said about itself — `null` when it said nothing. A stated origin
   * off the list is refused; a request with none is admitted, because `Origin` is a browser's own
   * declaration and refusing its absence turns away every server-side client while stopping no
   * attacker, who would simply omit it.
   */
  readonly admitsOrigin: (origin: string | null) => boolean;
  readonly announces: (room: string) => boolean;
  readonly admitsJoin: (request: Request, room: string) => Promise<boolean>;
}

export function createRoomAccess(posture: RelayPosture = {}): RoomAccess {
  return {
    admitsOrigin: (origin) =>
      posture.allowedOrigins === undefined ||
      origin === null ||
      posture.allowedOrigins.includes(origin),
    announces: (room) => posture.announce !== false || posture.rooms?.includes(room) === true,
    admitsJoin: async (request, room) => (await posture.verifyJoin?.(request, room)) ?? true,
  };
}
