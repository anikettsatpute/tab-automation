import { defineConfig } from "vite";
import { resolve } from "node:path";

// Single port 3000: Hono serves setup wizard (/) + dashboard (/dashboard) + API.
// Two Vite apps: setup-app -> dist-setup, dashboard-app -> dist-dashboard.
// Build both: npm run build:all
export default defineConfig({
  root: "setup-app",
  base: "./",
  build: {
    outDir: "../dist-setup",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        setup: resolve(__dirname, "setup-app/index.html"),
      },
    },
  },
});
