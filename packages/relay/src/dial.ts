import type { RelayDial } from "./transport.js";

/**
 * A `dial` over the platform WebSocket (browser, Bun, Node ≥ 21): resolves once open,
 * rejects if the socket errors first. Frames are binary; `send` throws unless the socket
 * is open, which is the honest-send rule reconnect depends on.
 */
export const webSocketDial = (url: string) => (): Promise<RelayDial> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const frames = new Set<(frame: Uint8Array) => void>();
    const closes = new Set<() => void>();
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve({
        send: (frame) => {
          if (ws.readyState !== WebSocket.OPEN) throw new Error("relay socket is not open");
          ws.send(frame);
        },
        onFrame: (cb) => {
          frames.add(cb);
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
      if (message.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(message.data);
        for (const cb of frames) cb(bytes);
      }
    };
    ws.onclose = () => {
      for (const cb of closes) cb();
    };
  });
