import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * One build serves both ways:
 * - bundled: hosts serve `dist/` from the instance; the app calls the API where it was loaded from.
 * - standalone: set VITE_NEO_API_URL at build time and deploy `dist/` anywhere.
 * Assets use relative paths (`base: "./"`), so the same build works at `/` and under `/i/<name>/`.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    // `bun run dev:web` against a local `neo serve`: same-origin through the proxy.
    proxy: {
      "/v1": {
        target: process.env.NEO_DEV_API ?? "http://127.0.0.1:7420",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
