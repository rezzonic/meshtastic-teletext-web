import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const shim = (name) => fileURLToPath(new URL(`./src/shims/${name}.js`, import.meta.url));

export default defineConfig({
  // Relative paths: GitHub Pages serves the app under /<repository>/.
  base: "./",
  build: { target: "es2022" },
  resolve: {
    // @meshtastic/core bundles the Node build of its logger, which imports
    // these three modules and calls process.cwd(); without stand-ins the
    // first log line throws in the browser.
    alias: { path: shim("path"), os: shim("os"), util: shim("util") },
  },
  define: {
    "process.cwd": "(() => \"\")",
    // Any other reference reads undefined instead of throwing.
    process: "globalThis.process",
  },
});
