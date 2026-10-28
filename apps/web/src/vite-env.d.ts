/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Standalone builds: the instance's API URL, e.g. https://neo.example.workers.dev/i/me. Empty: same origin. */
  readonly VITE_NEO_API_URL?: string;
}
