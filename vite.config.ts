import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  worker: {
    // 插件沙箱用 `new Worker(new URL("./worker/sandbox.worker.ts", import.meta.url), { type: "module" })`
    // 构造。Vite 默认把 worker 打成 iife，与 `type: "module"` 不配套，显式指定。
    format: "es",
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    setupFiles: ["./src/locales/test-setup.ts"],
  },
}));
