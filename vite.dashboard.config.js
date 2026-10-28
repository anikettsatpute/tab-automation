import { defineConfig } from "vite";

// Control Room dashboard app -> dist-dashboard (served at /dashboard on port 3000)
// base MUST be /dashboard/ so assets resolve to /dashboard/assets/*, not /assets/*
export default defineConfig({
  root: "dashboard-app",
  base: "/dashboard/",
  build: {
    outDir: "../dist-dashboard",
    emptyOutDir: true,
  },
});
