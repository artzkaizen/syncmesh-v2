export type Unsubscribe = () => void;

export interface Hub<T> {
  readonly subscribe: (listener: (value: T) => void) => Unsubscribe;
  /** Calls every listener; one that throws is reported via `onThrow` and does not stop the others. */
  readonly emit: (value: T) => void;
}

export function createHub<T>(onThrow?: (cause: unknown) => void): Hub<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit: (value) => {
      for (const listener of listeners) {
        try {
          listener(value);
        } catch (cause) {
          onThrow?.(cause);
        }
      }
    },
  };
}
