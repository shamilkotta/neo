import { useSyncExternalStore } from "react";

type Updater<T> = (current: T) => T;

function isUpdater<T>(next: T | Updater<T>): next is Updater<T> {
  return typeof next === "function";
}

export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  return {
    get: () => value,
    set(next: T | Updater<T>) {
      value = isUpdater(next) ? next(value) : next;
      for (const fn of listeners) fn();
    },
    use: () => useSyncExternalStore(subscribe, () => value),
  };
}
