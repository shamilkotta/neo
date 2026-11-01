/** The instance's API: `/i` where the app was loaded from, or VITE_NEO_API_URL (standalone). */
export function apiUrl(): string {
  const configured = import.meta.env.VITE_NEO_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  return `${location.origin}/i`;
}

const tokenKey = (url: string) => `neo.token:${url}`;

export function loadToken(url: string): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromHash) {
    localStorage.setItem(tokenKey(url), fromHash);
    history.replaceState(null, "", location.pathname + location.search);
    return fromHash;
  }
  return localStorage.getItem(tokenKey(url));
}

export const saveToken = (url: string, token: string) =>
  localStorage.setItem(tokenKey(url), token);
export const forgetToken = (url: string) =>
  localStorage.removeItem(tokenKey(url));
