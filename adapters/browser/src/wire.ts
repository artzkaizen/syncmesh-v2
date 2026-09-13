/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the page's end of a `postMessage`: a reply arrives as `unknown` and a serialized tagged error has no shape until the class that declared it revives */

import type { TxReceipt } from "@syncmesh/storage";

import type { MeshLink } from "./link.js";
import type { Ask, HostMessage, Topic } from "./protocol.js";

import { MeshHostGone, failures } from "./protocol.js";

/**
 * The tab's end of the conversation: calls out, events in, and one death.
 *
 * Two shapes over one port, which is the whole difference from the request/reply wire
 * `adapters/sqlite-wasm` ships. A reply is paired by id; an event is the host speaking first,
 * because a live query is a standing interest rather than a question. A message with no id is
 * therefore never a late reply and never needs a pending slot.
 */
export interface MeshWire {
  /** Throws the host's own tagged failure, revived, because that is what the surface underneath does. */
  readonly ask: <T>(body: Ask) => Promise<T>;
  readonly listen: (topic: Topic, listener: (payload: unknown) => void) => () => void;
  /** Receipts for writes this tab made through that handle; the host routes nobody else's here. */
  readonly onCommit: (handle: number, listener: (receipt: TxReceipt) => void) => () => void;
  readonly close: () => void;
}

const gone = (why: string) => new MeshHostGone({ message: why });

export function openWire(link: MeshLink): MeshWire {
  const pending = new Map<number, (reply: HostMessage) => void>();
  const topics = new Map<Topic, Set<(payload: unknown) => void>>();
  const commits = new Map<number, Set<(receipt: TxReceipt) => void>>();
  let next = 0;
  let dead = false;

  const deliver = (message: HostMessage): void => {
    if (!("kind" in message)) {
      const settle = pending.get(message.id);
      pending.delete(message.id);
      settle?.(message);
      return;
    }
    if (message.kind === "commit") {
      // SAFETY: the host posts a `commit` with the receipt its own handle reported, and nothing else
      const receipt = message.payload as TxReceipt;
      for (const listener of commits.get(message.handle) ?? []) listener(receipt);
      return;
    }
    for (const listener of topics.get(message.topic) ?? []) listener(message.payload);
  };

  link.port.onmessage = (event) => {
    // SAFETY: the only sender is `serveMesh`, whose every post is a `HostMessage`
    deliver(event.data as HostMessage);
  };

  /**
   * Every call out settles, including the ones the host will never answer.
   *
   * A leader's tab closing leaves its `MessagePort` open and silent, so a promise waiting on it
   * waits for ever — which in a UI is a spinner that outlives the thread it was spinning for.
   * The election tells the link it died; the link tells this; every slot fails as {@link MeshHostGone}.
   */
  const die = (): void => {
    if (dead) return;
    dead = true;
    const waiting = [...pending.values()];
    pending.clear();
    for (const settle of waiting)
      settle({
        id: 0,
        ok: false,
        error: { _tag: "MeshHostGone", message: "the host's tab closed" },
      });
  };
  const offLost = link.onLost(die);

  const ask = <T>(body: Ask): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (dead) {
        reject(gone("the host's tab closed"));
        return;
      }
      const id = (next += 1);
      pending.set(id, (reply) => {
        if ("kind" in reply || reply.ok) {
          // SAFETY: the host answers each ask with what that ask's own method returns; `Ask` is
          // a closed union and every arm's answer is named beside it in protocol.ts
          resolve(("kind" in reply ? null : reply.value) as T);
          return;
        }
        reject(failures.revive(reply.error) ?? gone("the host refused without saying why"));
      });
      link.port.postMessage({ id, ...body });
    });

  /** One host-side subscription per topic per tab, however many live queries are watching it. */
  const listen: MeshWire["listen"] = (topic, listener) => {
    const held = topics.get(topic);
    if (held === undefined) {
      topics.set(topic, new Set([listener]));
      void ask({ kind: "subscribe", topic }).catch(() => undefined);
    } else held.add(listener);
    return () => {
      const set = topics.get(topic);
      if (set === undefined || !set.delete(listener) || set.size > 0) return;
      topics.delete(topic);
      void ask({ kind: "unsubscribe", topic }).catch(() => undefined);
    };
  };

  const onCommit: MeshWire["onCommit"] = (handle, listener) => {
    const held = commits.get(handle) ?? new Set();
    held.add(listener);
    commits.set(handle, held);
    return () => void held.delete(listener);
  };

  return {
    ask,
    listen,
    onCommit,
    close: () => {
      offLost();
      if (!dead) link.port.postMessage({ kind: "bye" });
      die();
      topics.clear();
      commits.clear();
      link.close();
    },
  };
}
