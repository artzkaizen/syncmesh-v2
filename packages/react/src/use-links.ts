import type { LinkEvent } from "@syncmesh/transport";

import { useCallback, useEffect, useRef, useState } from "react";

export interface LinksSource {
  readonly $transports: {
    readonly onLinkEvent: (listener: (event: LinkEvent) => void) => () => void;
  };
}

/** Enough to explain a session; a device diagnosing a radio does not need its whole history. */
const DEFAULT_KEPT = 50;

/**
 * The last `keep` link-level facts, newest first — the story a status badge is the last line of.
 *
 * "Bluetooth is not syncing" is a sentence about at least five different failures, and a
 * condition alone distinguishes none of them: nobody was found; somebody was found and turned
 * away at the door; a dial that never connected; a handshake that failed; a proven link that
 * carried nothing. Each of those is a `LinkEvent` with a `kind` and, where there is one, a `why`
 * in words — and this keeps them, so a screen can show the sequence rather than the verdict.
 *
 * ```tsx
 * const events = useLinkEvents();
 * // refused peer=4a82… why=the door did not admit this peer
 * ```
 */
export function useLinkEvents(client: LinksSource, keep = DEFAULT_KEPT): readonly LinkEvent[] {
  const source = client;
  const [events, setEvents] = useState<readonly LinkEvent[]>([]);
  const kept = useRef(keep);
  kept.current = keep;
  const arrive = useCallback(
    (event: LinkEvent) => setEvents((held) => [event, ...held].slice(0, kept.current)),
    [],
  );
  useEffect(() => source.$transports.onLinkEvent(arrive), [source, arrive]);
  return events;
}
