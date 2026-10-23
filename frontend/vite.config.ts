import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.VITE_API_TARGET ?? "http://localhost:8000", changeOrigin: false } },
  },
  // No data: URI inlining, so the CSP can keep font-src/img-src to 'self'.
  build: { sourcemap: false, chunkSizeWarningLimit: 900, assetsInlineLimit: 0 },
});
