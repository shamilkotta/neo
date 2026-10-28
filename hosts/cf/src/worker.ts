export { InstanceDO } from "./instance";

/**
 * One Neo instance per name, at `/i/<name>/`:
 * - `/i/<name>/v1/...` is that instance's API, in the Durable Object named <name>;
 * - anything else under it is the bundled web app, which calls the API under the same prefix.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/i\/([A-Za-z0-9_-]{1,64})(\/.*)?$/.exec(url.pathname);
    if (!match) return Response.json({ error: "Open /i/<instance>/ (one Neo instance per name)" }, { status: 404 });
    const [, name, rest] = match;
    // The app uses relative paths, so its page must end with a slash.
    if (!rest) return Response.redirect(`${url.origin}/i/${name}/${url.search}${url.hash}`, 308);
    const inner = new Request(new URL(rest + url.search, url.origin), request);
    if (rest.startsWith("/v1/") || request.method === "OPTIONS") return env.INSTANCE.getByName(name!).fetch(inner);
    return env.ASSETS.fetch(inner);
  },
} satisfies ExportedHandler<Env>;
