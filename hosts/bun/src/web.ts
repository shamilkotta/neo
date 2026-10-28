import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { WEB_DIST } from "@neo/web/dist-path";

/**
 * Serves the bundled web app (apps/web, built to its dist/) next to the API: a file when one
 * matches, else index.html, so the app's own routes work. The app calls the API on this origin.
 */
export function webApp(dir = WEB_DIST): (request: Request) => Promise<Response> {
  const index = join(dir, "index.html");
  return async (request) => {
    if (!existsSync(index))
      return new Response("The web app is not built. Run `bun run build:web`, or use `bun run neo serve`, which builds it.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    const path = normalize(decodeURIComponent(new URL(request.url).pathname)).replace(/^(\.\.(\/|$))+/, "");
    const file = Bun.file(join(dir, path));
    if (path !== "/" && (await file.exists()))
      return new Response(file, {
        headers: path.startsWith("/assets/") ? { "cache-control": "public, max-age=31536000, immutable" } : {},
      });
    return new Response(Bun.file(index), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  };
}
