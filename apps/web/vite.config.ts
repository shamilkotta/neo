import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwind()],
  server: {
    proxy: {
      "/i": {
        target: process.env.NEO_DEV_API ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: (id) =>
          /node_modules\/(react|react-dom|scheduler)\//.test(id)
            ? "react"
            : /node_modules\/(marked|dompurify)\//.test(id)
              ? "markdown"
              : /node_modules\/typebox\//.test(id)
                ? "typebox"
                : undefined,
      },
    },
  },
});
