/**
 * The dev server's inspector socket, as the two calls a profiler needs: find the app, talk to it.
 *
 * Chrome DevTools Protocol over the Metro inspector proxy. Metro lists every attached runtime at
 * `/json/list`; each entry carries the socket its debugger speaks on, and Hermes answers the
 * `Profiler` domain on that socket.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion -- this file *is* the wire boundary: CDP is a JSON protocol whose envelope is `{id, result | error}` and whose payload shape is the method's, known only to the caller. The guards below are the parse, and the profile is parsed again by `read.ts` before anything is believed */

/** One runtime Metro can see. A device with the app open contributes at least one. */
export interface Target {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly vm?: string;
  readonly webSocketDebuggerUrl?: string;
  readonly reactNative?: { readonly logicalDeviceId?: string };
}

/** What a CDP reply carries when the call failed rather than answered. */
interface Refusal {
  readonly code: number;
  readonly message: string;
}

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- `/json/list` is JSON off the wire; this guard is where it becomes a `Target` */
const isTarget = (value: unknown): value is Target =>
  typeof value === "object" && value !== null && "webSocketDebuggerUrl" in value;

/** Every runtime attached to this dev server, newest listing first. */
export const targetsAt = async (url: string): Promise<readonly Target[]> => {
  const answered = await fetch(new URL("/json/list", url));
  if (!answered.ok) throw new Error(`${url} answered ${String(answered.status)} for /json/list`);
  const listed: unknown = await answered.json();
  return Array.isArray(listed) ? listed.filter(isTarget) : [];
};

/**
 * The app's own runtime, out of everything Metro lists — **the most recent one**.
 *
 * A device that reloaded leaves its previous connection in the listing for a while, and the stale
 * entry still upgrades: connecting to it records an empty profile, which looks exactly like a
 * stall the JS thread had no part in — the one reading this tool exists to make trustworthy. The
 * newest entry is last, so that is the one taken, and `--device` names another.
 */
export const appAmong = (targets: readonly Target[], device?: string): Target | undefined =>
  device === undefined
    ? targets.at(-1)
    : targets.find((one) => one.reactNative?.logicalDeviceId?.startsWith(device) === true);

/** A connected debugger: `send(method, params)` resolves with the result, or throws the refusal. */
export interface Debugger {
  readonly send: (method: string, params?: object) => Promise<Record<string, unknown>>;
  readonly close: () => void;
}

/**
 * Opens the debugger socket, **claiming the dev server's own origin**.
 *
 * Without it the upgrade is refused with a bare `401 Unauthorized` and no hint: Metro admits the
 * inspector only to the DevTools frontend it serves, which is same-origin with the dev server, so
 * a tool that wants the same access has to say the same thing.
 */
export const connectTo = async (socketUrl: string, origin: string): Promise<Debugger> => {
  const socket = new WebSocket(socketUrl, { headers: { Origin: origin } });
  const waiting = new Map<
    number,
    { ok: (r: Record<string, unknown>) => void; no: (e: Error) => void }
  >();
  let last = 0;

  await new Promise<void>((done, fail) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener(
      "error",
      () => fail(new Error(`could not open the inspector socket at ${socketUrl}`)),
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (typeof message !== "object" || message === null || !("id" in message)) return;
    const { id } = message;
    if (typeof id !== "number") return;
    const held = waiting.get(id);
    if (held === undefined) return;
    waiting.delete(id);
    const refusal: unknown = "error" in message ? message.error : undefined;
    if (refusal !== undefined) {
      const said = refusal as Refusal;
      held.no(new Error(`${said.message} (${String(said.code)})`));
      return;
    }
    const result: unknown = "result" in message ? message.result : {};
    held.ok(
      typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {},
    );
  });

  return {
    send: (method, params = {}) =>
      new Promise((ok, no) => {
        last += 1;
        waiting.set(last, { no, ok });
        socket.send(JSON.stringify({ id: last, method, params }));
      }),
    close: () => socket.close(),
  };
};
