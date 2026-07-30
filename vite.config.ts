import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Name the split deliberately. Recharts is by far the heaviest thing we
        // ship, and it is only needed once a chart-bearing view mounts — the
        // shell, the header and the consensus matrix (hand-rolled DOM) do not
        // touch it. Left to automatic chunking it ends up attached to whichever
        // module rollup happened to see first, which produced a 374 KB chunk
        // named "Kpi" and made the cost impossible to reason about.
        manualChunks: (id) => {
          if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-")) return "charts";
          if (id.includes("node_modules/react")) return "react";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Local dev proxies /api to `wrangler pages dev` so the frontend uses the
    // same same-origin paths it will use in production. Run both:
    //   npx wrangler pages dev dist --port 8788   (Functions + D1)
    //   npm run dev                                (Vite)
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
});
