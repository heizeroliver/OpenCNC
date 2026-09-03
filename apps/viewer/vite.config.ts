import { defineConfig } from "vite";

export default defineConfig({
  // Electron loads the packaged viewer through file://, so its assets must be
  // resolved relative to dist/index.html instead of the filesystem root.
  base: "./"
});
