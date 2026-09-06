import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/* The SPA talks to the community server on its own origin in production; in
   development Vite proxies both REST and the socket so the client never needs
   to know a second host. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@elaine/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
})
