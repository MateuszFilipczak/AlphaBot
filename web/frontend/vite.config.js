import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev (`npm run dev`) the API is proxied to the FastAPI server on :8000.
// In production FastAPI serves the built dist/ itself, same origin, no proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
