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
      // `.devdata/` 是隔离调试实例的**数据目录**（笔记、已装插件、字体…），不是源码，
      // 在 .gitignore 里也一样被排除。
      //
      // 这里必须显式忽略，否则它会**把整个 dev server 拖崩**：应用会把里面的文件真正
      // 打开着（装了 font-pack 之后加载的 .ttf 就是），Windows 上对已占用的文件
      // `fs.watch` 直接返回 EBUSY，而 chokidar 把它当作致命错误抛出 ——
      // Vite 进程退出，`beforeDevCommand` 非零退出，Tauri 跟着关掉。
      ignored: ["**/src-tauri/**", "**/.devdata/**"],
    },
  },
  test: {
    setupFiles: ["./src/locales/test-setup.ts"],
  },
}));
