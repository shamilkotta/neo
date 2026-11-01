export type InstanceState = "empty" | "active" | "sealed" | "moved";

export class StateError extends Error {
  constructor(
    readonly state: InstanceState,
    message: string,
  ) {
    super(message);
  }
}

export class SetupError extends Error {}
