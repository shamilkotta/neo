import { AttachmentError } from "./agent/attachments";
import { MailboxError } from "./agent/mailbox";
import { ScheduleError } from "./agent/schedules";
import { RegistryError } from "./coordinator/registry";
import { timingSafeEqual } from "./crypto";
import { BundleError } from "./move/bundle";
import { SetupError, StateError } from "./errors";
import { MemoryError } from "./services/memory";
import { VfsError } from "./vfs/vfs";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, last-event-id, x-neo-passphrase",
  "access-control-max-age": "86400",
};

export const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "The body is not JSON");
  }
}

export const preflight = () =>
  new Response(null, { status: 204, headers: CORS });

export function authorized(request: Request, token: string): boolean {
  const given = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  return !!given && timingSafeEqual(given, token);
}

export const unauthorized = () =>
  withCors(json({ error: "Unauthorized" }, 401));

export type Router = (request: Request, url: URL) => Promise<Response>;

/** CORS, preflight and error mapping around a router. Hosts route and check the token before this. */
export async function serve(
  request: Request,
  route: Router,
): Promise<Response> {
  if (request.method === "OPTIONS") return preflight();
  const url = new URL(request.url);
  let response: Response;
  try {
    response = await route(request, url);
  } catch (error) {
    response = errorResponse(error);
  }
  return withCors(response);
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError)
    return json({ error: error.message }, error.status);
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof StateError)
    return json({ error: message, state: error.state }, 409);
  if (error instanceof SetupError)
    return json({ error: message, setup: true }, 409);
  if (error instanceof RegistryError) return json({ error: message }, 409);
  if (
    error instanceof MailboxError ||
    error instanceof AttachmentError ||
    error instanceof ScheduleError ||
    error instanceof BundleError ||
    error instanceof MemoryError
  )
    return json({ error: message }, 400);
  if (error instanceof VfsError)
    return json(
      { error: message, code: error.code },
      error.code === "not_found" ? 404 : 400,
    );
  return json({ error: message }, 500);
}

/** The durable and live event stream (SSE, resumable with `after` or Last-Event-ID). */
export function eventStream(
  events: {
    stream(after: number, signal: AbortSignal): ReadableStream<Uint8Array>;
  },
  request: Request,
  url: URL,
): Response {
  const after =
    Number(
      url.searchParams.get("after") ??
        request.headers.get("last-event-id") ??
        0,
    ) || 0;
  return new Response(events.stream(after, request.signal), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

export function matcher(request: Request, url: URL) {
  const { method } = request;
  const path = url.pathname;
  return {
    is: (m: string, p: string) => method === m && path === p,
    match: (m: string, pattern: RegExp) =>
      method === m ? pattern.exec(path) : null,
  };
}
