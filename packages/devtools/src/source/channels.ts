import type { Unsubscribe } from "@syncmesh/engine";

import { Result } from "@syncmesh/result";

import type { DevtoolsChannel } from "../contract.js";

/**
 * The one place a fact becomes a notification, and the reason the devtool is affordable.
 *
 * `engine.onFoldBatch` and `engine.onTelemetry` run **synchronously inside the write path**, so
 * whatever they call is a tax on every write the app makes and every batch it receives. Everything
 * here is arranged around that single sentence: {@link Channels.moved} adds a string to a `Set`
 * that was allocated once and schedules a microtask if one is not already scheduled. It reads
 * nothing, allocates nothing, formats nothing, and calls no listener. A hundred folds in a tick
 * are one repaint, which is also what a reader wants — nobody can see a table redrawn per event.
 *
 * A source with no listeners does not even record: there is no one to tell, and a set quietly
 * filling up between subscriptions would deliver a burst of stale channels to whoever attached
 * next.
 */

export interface Channels {
  /** Marks a channel moved. Safe to call from the write path; see the note above. */
  readonly moved: (channel: DevtoolsChannel) => void;
  readonly subscribe: (listener: (moved: ReadonlySet<DevtoolsChannel>) => void) => Unsubscribe;
  /** Drops every listener and abandons whatever was pending. */
  readonly close: () => void;
}

export interface ChannelOptions {
  /**
   * How the flush is deferred. A microtask by default, which is after the write that caused it
   * has finished and before the browser can paint — the latest a repaint can be decided and the
   * earliest it can be shown.
   */
  readonly schedule?: (flush: () => void) => void;
  /**
   * What a listener threw. One panel's thrown listener must not silence the others, so the loop
   * carries on and the cause comes out here rather than up the stack of whichever write happened
   * to be running.
   */
  readonly onError?: (cause: unknown) => void;
}

export function createChannels(options: ChannelOptions = {}): Channels {
  const { schedule = queueMicrotask, onError } = options;
  const listeners = new Set<(moved: ReadonlySet<DevtoolsChannel>) => void>();
  const pending = new Set<DevtoolsChannel>();
  let scheduled = false;
  let closed = false;

  const flush = (): void => {
    scheduled = false;
    if (closed || pending.size === 0) return;
    // the set outlives this call the moment a panel puts it in React state, so it is a copy
    const moved: ReadonlySet<DevtoolsChannel> = new Set(pending);
    pending.clear();
    // a copy, because a panel that subscribes while being told must not also be told in this pass
    for (const listener of Array.from(listeners)) {
      const told = Result.try({ try: () => listener(moved), catch: (cause: unknown) => cause });
      if (told.isErr()) onError?.(told.error);
    }
  };

  return {
    moved: (channel) => {
      if (closed || listeners.size === 0) return;
      pending.add(channel);
      if (scheduled) return;
      scheduled = true;
      schedule(flush);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: () => {
      closed = true;
      listeners.clear();
      pending.clear();
    },
  };
}
