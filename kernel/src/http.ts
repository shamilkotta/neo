import type { Static, TSchema } from "typebox";
import { tokenFromProtocols } from "@neo/client";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { validator } from "hono/validator";
import { Value } from "typebox/value";
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
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
  }
}

export const withCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: [
    "authorization",
    "content-type",
    "last-event-id",
    "x-neo-passphrase",
  ],
  maxAge: 86400,
});

export function api() {
  const app = new Hono();
  app.use(withCors);
  app.use(async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => errorResponse(c, error));
  return app;
}

export function valid<const S extends TSchema>(
  schema: S,
  data: unknown,
  part = "body",
): Static<S> {
  if (Value.Check(schema, data)) return data;
  const [first] = Value.Errors(schema, data);
  throw new HttpError(
    400,
    first
      ? `Invalid ${part}: ${first.instancePath || "/"} ${first.message}`
      : `Invalid ${part}`,
  );
}

export const jsonBody = <const S extends TSchema>(schema: S) =>
  validator("json", (value): Static<S> => valid(schema, value));

export const queryParams = <const S extends TSchema>(schema: S) =>
  validator("query", (value): Static<S> =>
    valid(schema, Value.Convert(schema, value), "query"),
  );

export const pathParams = <const S extends TSchema>(schema: S) =>
  validator("param", (value): Static<S> => {
    if (!Value.Check(schema, value)) throw new HttpError(404, "Not found");
    return value;
  });

export function authorized(request: Request, token: string) {
  const given =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    tokenFromProtocols(request.headers.get("sec-websocket-protocol"));
  return !!given && timingSafeEqual(given, token);
}

export const requireToken =
  (token: (c: Context) => string): MiddlewareHandler =>
  async (c, next) => {
    if (authorized(c.req.raw, token(c))) return next();
    await withCors(c, async () => {
      c.res = c.json({ error: "Unauthorized" }, 401);
    });
    return c.res;
  };

function errorResponse(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HttpError)
    return c.json({ error: message }, error.status);
  if (error instanceof HTTPException)
    return c.json({ error: message }, error.status);
  if (error instanceof StateError)
    return c.json({ error: message, state: error.state }, 409);
  if (error instanceof SetupError)
    return c.json({ error: message, setup: true }, 409);
  if (error instanceof RegistryError) return c.json({ error: message }, 409);
  if (
    error instanceof MailboxError ||
    error instanceof AttachmentError ||
    error instanceof ScheduleError ||
    error instanceof BundleError ||
    error instanceof MemoryError
  )
    return c.json({ error: message }, 400);
  if (error instanceof VfsError)
    return c.json(
      { error: message, code: error.code },
      error.code === "not_found" ? 404 : 400,
    );
  return c.json({ error: message }, 500);
}
