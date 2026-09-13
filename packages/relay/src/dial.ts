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
          // SAFETY: the DOM types `send` as taking a view over a plain `ArrayBuffer`, and a bare
          // `Uint8Array` is over `ArrayBufferLike` — which is to say it *could* be over a
          // `SharedArrayBuffer`. Nothing in syncmesh allocates one: every frame reaching here was
          // built by `@syncmesh/transport` or this package. Sending a copy instead would be a
          // second allocation per frame to satisfy a case that does not occur.
          ws.send(frame as Uint8Array<ArrayBuffer>);
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
