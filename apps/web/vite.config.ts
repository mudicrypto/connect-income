import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    // Same-origin API in development so the SameSite=Strict session cookie works.
    // xfwd: pass the browser's address as X-Forwarded-For (the API trusts loopback proxies only).
    proxy: { "/api": { target: "http://127.0.0.1:4000", xfwd: true } },
  },
});
