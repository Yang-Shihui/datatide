import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    port: 5174,
    proxy: {
      "/auth": "http://127.0.0.1:8200",
      "/api": "http://127.0.0.1:8200",
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: "index.html",
        harness: "harness/harness.html",
      },
    },
  },
});
