import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const entryBuildStamp =
  process.env.CHIHU_REMOTE_BUILD_STAMP ||
  new Date().toISOString().replace(/\D/g, "").slice(0, 14);

export default defineConfig({
  base: "/new-remote-web/",
  plugins: [
    react(),
    {
      name: "chihu-entry-cache-bust",
      transformIndexHtml: {
        order: "post",
        handler(html) {
          return html
            .replace(/(src|href)="(\/new-remote-web\/(?:app\.js|styles\.css))"/g, `$1="$2?v=${entryBuildStamp}"`)
            .replace(/src="\.\/bridge\.js"/g, `src="./bridge.js?v=${entryBuildStamp}"`);
        }
      }
    }
  ],
  build: {
    outDir: resolve(__dirname, "../new-remote-web"),
    emptyOutDir: true,
    assetsDir: "assets",
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith(".css")) {
            return "styles.css";
          }
          return "assets/[name]-[hash][extname]";
        }
      }
    }
  },
  server: {
    host: "127.0.0.1"
  }
});
