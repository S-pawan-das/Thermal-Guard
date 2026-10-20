import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND = "http://localhost:3001";

// In development the browser talks only to Vite (port 5173);
// Vite forwards /api and /socket.io to the backend, so no CORS is involved.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [".."] }, // lets the client import ../shared at the repo root
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/socket.io": { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
});
