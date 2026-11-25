import { defineConfig } from "vite";

// One file for the server, Node's own modules aside: nothing to install there.
export default defineConfig({
  ssr: { noExternal: true },
  build: {
    target: "node24",
    minify: false,
    rolldownOptions: { output: { entryFileNames: "sondine-compute.js" } },
  },
});
