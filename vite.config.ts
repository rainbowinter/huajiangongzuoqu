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
    // 默认（`css: false`）Vitest 把 `.css` 一律 stub 成空模块，**连 `?raw` 都拿不到内容**。
    // 这里只放行「样式即接口」的那两份文件，`semanticHooks.test.ts` 要读它们的真实文本：
    // `custom.css` 里写着语义钩子清单，`App.css` 里是本来就带样式的那批既有语义类。
    // 其余 CSS 仍旧一律 stub，所有测试的行为不变。
    // ⚠️ 这两条**不要加 `$` 锚点**：Vitest 拿去匹配的 id 末尾还挂着 `?raw` 查询串，
    // 锚死在结尾就一条都匹配不上，`?raw` 又退回空模块。
    css: { include: [/custom\.css/, /App\.css/] },
    // ⚠️ `src-tauri/target/` 里会出现一份**构建时拷进去的 example-plugins-v2**；
    // 不排除的话，插件目录里的 `*.test.js` 会被再跑一遍（同一个测试出现两次）。
    // `.devdata/` 是隔离实例的数据目录，同样不是源码。
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "**/.devdata/**",
      "**/src-tauri/target/**",
      // office-viewer 的 `differential/reference` 里是一批**第三方参考实现**，
      // 自带几十个 `.test.mjs`；它们不是花笺的测试，跑起来还会起服务 / 卡住。
      "**/example-plugins-v2/office-viewer/differential/**",
    ],
  },
}));
