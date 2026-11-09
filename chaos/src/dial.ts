import type { RelayDial } from "@syncmesh/relay";

/**
 * The close reasons the relay hangs up with on a typed refusal (`connection.ts`'s `refuse`). Not
 * `retention`: that refusal leaves the socket open for what the device hands over, and the device
 * reports it itself, as a `$recovery` issue `report` reads (`world.ts`).
 */
const REFUSALS = new Set(["version"]);

/**
 * `webSocketDial`, with the close reason kept.
 *
 * The relay refuses a build it does not speak with a typed `error` frame and closes the socket
 * with the code as its reason. On a sealed link the frame is not readable from here, and the
 * library's dial drops the reason. This copy differs only in handing that reason to `onRefused`,
 * so the ledger can record the refusal the device was given.
 */
const reasonDial = (url: string, onRefused: (code: string) => void) => (): Promise<RelayDial> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const frames = new Set<(frame: Uint8Array) => void>();
    const closes = new Set<() => void>();
    const early: Uint8Array[] = [];
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve({
        send: (frame) => {
          if (ws.readyState !== WebSocket.OPEN) throw new Error("relay socket is not open");
          // SAFETY: every frame reaching here was built by `@syncmesh/relay` over a plain `ArrayBuffer`
          ws.send(frame as Uint8Array<ArrayBuffer>);
        },
        onFrame: (cb) => {
          frames.add(cb);
          for (const bytes of early.splice(0)) cb(bytes);
          return () => void frames.delete(cb);
        },
        onClose: (cb) => {
          closes.add(cb);
          return () => void closes.delete(cb);
        },
        close: () => ws.close(),
      });
    };
    ws.onerror = () => {
      if (!opened) reject(new Error(`could not reach ${url}`));
    };
    ws.onmessage = (message) => {
      if (!(message.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(message.data);
      if (frames.size === 0) early.push(bytes);
      else for (const cb of frames) cb(bytes);
    };
    ws.onclose = (event) => {
      if (REFUSALS.has(event.reason)) onRefused(event.reason);
      for (const cb of closes) cb();
    };
  });

/**
 * A relay link that can be cut.
 *
 * `relayTransport` reconnects on its own, which is the behaviour under test — so taking the link
 * down means refusing the dial rather than reaching inside the transport. The socket already open
 * is closed too, or the transport keeps using a link the schedule believes is gone.
 */
export const cuttableDial = (url: string, onRefused: (code: string) => void) => {
  const open = new Set<{ readonly close: () => void }>();
  let up = true;
  const dial = async (): Promise<RelayDial> => {
    if (!up) throw new Error("relay unreachable");
    const dialed = await reasonDial(url, onRefused)();
    // cut while the dial was in flight: the socket that opened anyway is one the schedule
    // believes is gone, and the sleeper that kept it was never asleep (seed 1, `--retention`)
    if (!up) {
      dialed.close();
      throw new Error("relay unreachable");
    }
    open.add(dialed);
    return dialed;
  };
  return {
    dial,
    set: (next: boolean) => {
      up = next;
      if (next) return;
      for (const dialed of open) dialed.close();
      open.clear();
    },
  };
};
