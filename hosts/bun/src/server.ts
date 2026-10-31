import { BunHost, type BunHostOptions } from "./host";
import { webApp } from "./web";

export interface ServeOptions extends BunHostOptions {
  port: number;
  hostname?: string;
  web?: boolean;
}

export async function serve(options: ServeOptions) {
  const host = new BunHost(options);
  const neo = await host.open();
  const web = webApp();
  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname ?? "127.0.0.1",
    idleTimeout: 0,
    fetch: (request) =>
      options.web === false ||
      new URL(request.url).pathname.startsWith("/v1/") ||
      request.method === "OPTIONS"
        ? host.fetch(request)
        : web(request),
  });
  return {
    host,
    neo,
    server,
    token: host.token,
    url: `http://${server.hostname}:${server.port}`,
    async stop() {
      await server.stop(true);
      await host.close();
    },
  };
}
