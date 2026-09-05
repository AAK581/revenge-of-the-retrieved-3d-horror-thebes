import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// base: "./" — the bundle is served from the chain under
// /_/raw/<cid>/, so every asset reference must be relative.
//
// The dev proxy forwards /api to the same chain the project deploys to by
// default — the localhost chain `thebes-deploy start` runs. Point a dev
// session at another chain with THEBES_GATEWAY, e.g.
//   THEBES_GATEWAY=https://memphis.mercaturaforum.com npm run dev
const gateway = process.env.THEBES_GATEWAY ?? "http://127.0.0.1:8180";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    rollupOptions: {
      /**
       * Two entries: the game, and the monster debug page.
       *
       * `debug.html` is a SEPARATE entry rather than a route inside the game so
       * that it cannot destabilise the shipping bundle — it imports the real
       * `Monster` class (the whole point: what you inspect is what ships) but
       * nothing in the game imports it back, so it is dead weight the game never
       * loads. Listing `index.html` explicitly is required: the moment
       * `rollupOptions.input` is set, Vite stops inferring the default entry.
       *
       * `base: "./"` above is deliberately untouched — the Thebes gateway serves
       * from /_/raw/<cid>/ and every asset reference has to stay relative.
       */
      input: {
        main: resolve(__dirname, "index.html"),
        debug: resolve(__dirname, "debug.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: gateway,
        changeOrigin: true,
      },
    },
  },
});
