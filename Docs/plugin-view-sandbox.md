# 插件视图的沙箱边界（以及为什么是这个边界）

给插件一个能跑 canvas / 自己 JS 的渲染环境（PDF 阅读器需要），同时**不能让它够到 Tauri 的
能力**。这份文档记的是**实测结论**，不是推理 —— 因为实测推翻了我原本的推理。

## 为什么需要它

插件现在的自定义渲染器（`kind: "custom"`）只能返回 **HTML 字符串**，还要过
`sanitizePluginHtml` 的白名单 —— 那里没有 `<script>` / `<canvas>` / `<iframe>`。
插件拿不到二进制（`readText` 只读 UTF-8），也没有写文件的权限。

PDF 阅读器这三样都要，所以要么把 PDF 做进宿主，要么**给插件一个真正的渲染环境**。
选了后者：把插件视图放进 `sandbox="allow-scripts"` 的 iframe。

## 实测结论（Windows / WebView2 155，2026-10）

在**真实运行时**里跑的探针（`src/dev/SandboxProbe.tsx`），沙箱帧内：

| 检查 | 结果 |
|---|---|
| `window.origin` | `null` —— **隔离生效** |
| 读 `parent.document` | 被挡 |
| `fetch` 应用自己 origin 的资源 | 被 CORS 拒（连应用自己的 HTML 都读不到） |
| 内联 `<script type="module">` | **能执行** |
| `new Worker(blob:)` | **可用** |
| `postMessage` 传 `ArrayBuffer` | 往返成功 |
| `typeof __TAURI_INTERNALS__` | **`object`** ⚠️ |
| `typeof __TAURI_INTERNALS__.invoke` | **`function`** ⚠️ |
| 调用 `app_name` / `update_endpoint` / **一个不存在的命令** | **全部失败，原因一模一样**：`Origin header is not a valid URL` |

## ⚠️ 安全性来自哪里（别搞错）

**不是**「Tauri 不往 iframe 注入 IPC」—— 实测**注入了**，`__TAURI_INTERNALS__` 就在那儿。
所以**用 `typeof` 去查会得出完全相反的结论**。

真正的闸门是**每次调用的 origin 检查**：沙箱帧的 `Origin` 是 `null`（不是一个合法 URL），
Tauri 在校验那一步就拒了，**根本走不到命令分派** —— 证据是「连不存在的命令」也报同一句话。

所以判断依据应该是：**能不能越过 origin 检查**，而不是「对象在不在」。

`sandbox="allow-scripts"`（**不给** `allow-same-origin`）让帧的 origin **永久**是 opaque
（沙箱标志跟着浏览上下文走，跨导航保留），因此它永远通不过这个检查。

反过来，`allow-scripts allow-same-origin` 或者干脆不给 sandbox，都可能让帧拿到真实 origin ——
官方安全公告 GHSA-57fm-592m-34r7 特别指出「Windows 上当 iframe 与窗口同源时可达到 IPC」。
**那两种给法一律否决。**

## 这个边界带来的设计约束

- **帧自己取不到文件**：`fetch(asset://…)` 会被 CORS 拒（Tauri 的 asset 响应把
  `Access-Control-Allow-Origin` 设成**窗口 origin**，不是 `*`）。所以**文档字节必须由宿主读、
  经 `postMessage` 带内送进去**，不能把 asset URL 丢给帧自己去取。
- **资源要内联**：外部 `<script type="module" src=…>` 与 `new Worker(assetUrl)` 在 opaque
  origin 下都不可用。视图的 HTML/CSS/JS 由宿主读成文本、拼成 `srcdoc`。
  好处是**不必为视图放宽 asset scope** —— 那会逼着我们去掉 sandbox，正是不能做的事。
- **pdf.js 可以带 Worker**：`blob:` Worker 可用（把 worker 源码拼成 Blob 即可），所以不必退回
  主线程模式。

## 还没实测、但按规范成立的一条

**帧自己导航到应用 origin 之后，沙箱还在不在。** 按 HTML 规范，沙箱标志是跟着浏览上下文走的，
跨导航保留，所以它应该仍然是 opaque、仍然通不过 origin 检查。探针里留了这条检查，但在
Windows 上它被「Vite 把任意路径都回成 index.html」搅乱了（帧里把整个应用又启动了一遍）。
**换平台（macOS / Linux）时值得单独补测一次** —— 那里的窗口 origin 是自定义 scheme，
行为可能与 Windows 不同。

## 怎么重跑探针

```bash
npm run dev:isolated
# 然后在 dev URL 后面加查询参数：http://localhost:1420/?sandboxProbe=1
```

结果走 `console.error` 输出（宿主侧只有 error 会被 Vite 转发到 dev-server 的 stdout）。

> ⚠️ 探针在每个窗口都会建一个 iframe 跑一遍，平时**不要挂**（`App.tsx` 里按
> `sandboxProbeEnabled()` 判断）。
