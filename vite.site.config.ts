import { defineConfig } from "vite";

// The hosted replay player. Paths are relative so the site works from any folder.
export default defineConfig({
  base: "./",
  clearScreen: false,
  worker: { format: "es" },
  build: { outDir: "build/site", emptyOutDir: true, rollupOptions: { input: "site.html" } },
});
