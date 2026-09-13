import type { TransportCondition } from "@syncmesh/transport";

import { createHub } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";

import type { DevtoolsSource } from "../contract.js";
import type { DevtoolsControls } from "../controls.js";

import { ControlRefused } from "../controls.js";
import { mockSource } from "./source.js";

/**
 * The fixture's controls, wired to the fixture's own mediums so the toggles do something.
 *
 * A fixture whose switches only recorded what they were told would have let the panel go green
 * while showing a medium as carrying immediately after it was held off — which is the one bug a
 * control surface can have that nobody notices until a real mesh is in front of them. So this
 * mutates the readings: a held medium reports the condition it is held in, says its status hub
 * called it down, and stops appearing in any peer's list of mediums.
 *
 * It is a fixture and not a second implementation. What it stands in for is the swap
 * `RunningTransports.force` performs — the real medium stopped and kept, a stand-in in its seat —
 * and the reason the two agree is that both are described entirely by what a reader can see.
 */

export interface MockMesh {
  readonly source: DevtoolsSource;
  readonly controls: DevtoolsControls;
}

export function mockMesh(overrides: Partial<DevtoolsSource> = {}): MockMesh {
  const held = new Map<string, TransportCondition>();
  const changed = createHub<void>();
  const base = mockSource(overrides);
  const source = {
    ...base,
    overview: () => {
      const seen = base.overview();
      return {
        ...seen,
        mediums: seen.mediums.map((medium) => {
          const as = held.get(medium.name);
          return as === undefined ? medium : { ...medium, condition: as, online: false };
        }),
      };
    },
    links: () => {
      const seen = base.links();
      return {
        ...seen,
        // a held medium carries nobody, which is the half a `condition` alone would not show
        peers: seen.peers
          .map((peer) => ({ ...peer, over: peer.over.filter((name) => !held.has(name)) }))
          .filter((peer) => peer.over.length > 0),
      };
    },
  } satisfies DevtoolsSource;

  const known = (name: string) => base.overview().mediums.some((medium) => medium.name === name);
  return {
    source,
    controls: {
      forced: () => [...held].map(([name, as]) => ({ name, as })),
      force: (name, as) => {
        if (!known(name))
          return Promise.resolve(
            Result.err(
              new ControlRefused({
                transport: name,
                action: "force",
                message: `no medium named ${name} is running`,
              }),
            ),
          );
        held.set(name, as);
        changed.emit();
        return Promise.resolve(Result.ok(undefined));
      },
      release: (name) => {
        if (!held.delete(name))
          return Promise.resolve(
            Result.err(
              new ControlRefused({
                transport: name,
                action: "release",
                message: `no medium named ${name} is held`,
              }),
            ),
          );
        changed.emit();
        return Promise.resolve(Result.ok(undefined));
      },
      onChange: (listener) => changed.subscribe(() => listener()),
    },
  };
}
