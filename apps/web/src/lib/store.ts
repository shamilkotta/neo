import { useSyncExternalStore } from "react";

export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  return {
    get: () => value,
    set(next: T | ((current: T) => T)) {
      value = next instanceof Function ? next(value) : next;
      for (const fn of listeners) fn();
    },
    use: () => useSyncExternalStore(subscribe, () => value),
  };
}
