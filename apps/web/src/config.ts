/**
 * Where the API is. A standalone build has it baked in (VITE_NEO_API_URL). A bundled build is
 * served by the instance itself, so the API is where the app was loaded from, including the
 * Cloudflare instance prefix `/i/<name>`.
 */
export function apiUrl(): string {
  const configured = import.meta.env.VITE_NEO_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  const prefix = /^\/i\/[A-Za-z0-9_-]{1,64}(?=\/|$)/.exec(location.pathname)?.[0] ?? "";
  return location.origin + prefix;
}

const tokenKey = (url: string) => `neo.token:${url}`;

/** The token for this API: from `#token=…` once (printed by `neo serve`), then this browser's storage. */
export function loadToken(url: string): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromHash) {
    localStorage.setItem(tokenKey(url), fromHash);
    history.replaceState(null, "", location.pathname + location.search);
    return fromHash;
  }
  return localStorage.getItem(tokenKey(url));
}

export const saveToken = (url: string, token: string) => localStorage.setItem(tokenKey(url), token);
export const forgetToken = (url: string) => localStorage.removeItem(tokenKey(url));
