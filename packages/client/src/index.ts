// @neo/client: Neo's API contract (wire types) and a typed client. Apps depend on this, never on the kernel.
export * from "./types";
export { NeoApiError, NeoClient, type NeoClientOptions } from "./client";
