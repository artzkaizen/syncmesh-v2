import type { RelayDial } from "./transport.js";

/**
 * Dialling a relay, and dialling it again (RFC-0005).
 *
 * Its own unit because it is its own decision and the transport around it has enough of those: a
 * socket that will not open is not an error the mesh has anything to do about, it is a delay that
 * doubles. Keeping the timer and the delay here means the transport never reads `backoff` and can
 * never be the place that forgets to reset it.
 *
 * There is no "give up". A relay that has been down for an hour is a relay somebody will start,
 * and a device that stopped trying would need a reload to notice — so the delay is capped and the
 * attempts are not. The one permanent refusal, a protocol version the relay will not speak, is the
 * transport's to know and it says so through {@link RedialOptions.done}.
 */
export interface Redial {
  /** Dial now. */
  readonly attempt: () => void;
  /** Schedule another attempt after the current delay, then double it. */
  readonly again: () => void;
  /** A session came up: the next failure starts from the first delay again. */
  readonly settled: () => void;
  /** Drop a scheduled attempt. It does not close anything — this unit holds no socket. */
  readonly cancel: () => void;
}

export interface RedialOptions {
  readonly dial: () => Promise<RelayDial> | RelayDial;
  /** First reconnect delay; doubles per failure up to `maxReconnectMs`. Default 500. */
  readonly reconnectMs?: number;
  readonly maxReconnectMs?: number;
  /**
   * Whether another attempt is wanted at all — stopped, or permanently refused.
   *
   * Asked again *after* the dial resolves as well as before it, because a socket that opened into
   * a transport which has since stopped is a socket nobody will read: closing it is what keeps a
   * stopped mesh from holding a connection open.
   */
  readonly done: () => boolean;
  readonly onDialed: (dialed: RelayDial) => void;
  readonly onFailed: (cause: unknown) => void;
}

export function createRedial(options: RedialOptions): Redial {
  const baseMs = options.reconnectMs ?? 500;
  const maxMs = options.maxReconnectMs ?? 30_000;
  let backoff = baseMs;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const again = (): void => {
    timer = setTimeout(attempt, backoff);
    backoff = Math.min(backoff * 2, maxMs);
  };

  const attempt = (): void => {
    if (options.done()) return;
    Promise.resolve()
      .then(() => options.dial())
      .then((dialed) => (options.done() ? dialed.close() : options.onDialed(dialed)))
      .catch((cause: unknown) => {
        options.onFailed(cause);
        again();
      });
  };

  return {
    attempt,
    again,
    settled: () => void (backoff = baseMs),
    cancel: () => clearTimeout(timer),
  };
}
