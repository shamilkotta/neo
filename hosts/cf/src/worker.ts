export { InstanceDO } from "./instance";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/i\/([A-Za-z0-9_-]{1,64})(\/.*)?$/.exec(url.pathname);
    if (!match)
      return Response.json(
        { error: "Open /i/<instance>/ (one Neo instance per name)" },
        { status: 404 },
      );
    const [, name, rest] = match;
    if (!rest)
      return Response.redirect(
        `${url.origin}/i/${name}/${url.search}${url.hash}`,
        308,
      );
    const inner = new Request(new URL(rest + url.search, url.origin), request);
    if (rest.startsWith("/v1/") || request.method === "OPTIONS")
      return env.INSTANCE.getByName(name!).fetch(inner);
    return env.ASSETS.fetch(inner);
  },
} satisfies ExportedHandler<Env>;
