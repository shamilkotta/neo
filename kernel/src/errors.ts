import { InstanceState, parse } from "@neo/client";

export type { InstanceState } from "@neo/client";

export const storedState = (value: string | undefined) =>
  value === undefined ? "empty" : parse(InstanceState, value);

export class StateError extends Error {
  constructor(
    readonly state: InstanceState,
    message: string,
  ) {
    super(message);
  }
}

export class SetupError extends Error {}

export function present<T>(value: T | undefined, what: string) {
  if (value === undefined) throw new Error(`${what} is missing`);
  return value;
}
