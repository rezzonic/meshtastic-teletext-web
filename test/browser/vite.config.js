// Builds test/browser/harness.html with the app's own config -- same shims,
// same defines -- so the browser run exercises the code that is published.
//   npx vite build --config test/browser/vite.config.js   -> dist-harness/
import { defineConfig, mergeConfig } from "vite";
import { fileURLToPath } from "node:url";
import base from "../../vite.config.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default mergeConfig(base, defineConfig({
  root: here("../.."),
  build: {
    outDir: here("../../dist-harness"),
    emptyOutDir: true,
    rollupOptions: { input: here("./harness.html") },
  },
}));
