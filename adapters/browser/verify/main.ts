import type { MeshLink } from "../src/link.js";

import { openMeshLink, rendezvousAvailable } from "../src/tabs.js";

const tab = Math.random().toString(36).slice(2, 6);
const state = {
  tab,
  mode: rendezvousAvailable() ? "shared" : "single-tab",
  role: "starting",
  host: "",
  lost: 0,
  reconnects: 0,
  failure: "",
};

const out = document.querySelector("#out");
const render = () => {
  if (out !== null) out.textContent = JSON.stringify(state, null, 2);
};

const who = (link: MeshLink) =>
  new Promise<string>((answered) => {
    link.port.onmessage = (event) => answered(event.data.host);
    link.port.postMessage("who");
  });

const connect = async (): Promise<void> => {
  const opened = await openMeshLink({
    worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    onPromoted: () => {
      state.reconnects += 1;
      void connect();
    },
  });
  if (opened.isErr()) {
    state.role = "none";
    state.host = "";
    state.failure = `${opened.error._tag}: ${opened.error.message}`;
    render();
    return;
  }
  const link = opened.value;
  state.role = link.role;
  state.failure = "";
  state.host = await who(link);
  render();
  link.onLost(() => {
    state.lost += 1;
    state.role = "lost";
    render();
    setTimeout(() => {
      state.reconnects += 1;
      void connect();
    }, 50);
  });
};

Object.assign(globalThis, {
  probe: async () => ({
    ...state,
    locks: await navigator.locks.query(),
  }),
});

void connect();
