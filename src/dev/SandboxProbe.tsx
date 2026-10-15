import { useEffect, useRef } from "react";

/**
 * ⚠️ **临时探针，验证完就删。**
 *
 * 阶段 0：把「插件视图」方案押注的那条安全前提实测一遍 ——
 * `sandbox="allow-scripts"`（不给 `allow-same-origin`）的 iframe 到底够不够得到 Tauri IPC。
 * 这条不成立，整个 iframe 方案作废（改走宿主内建渲染器）。
 *
 * 为什么用 `console.error` 回传：宿主侧只有 `console.error` 会被 Vite 转发到 dev-server
 * 的 stdout（`console.log` 不转发），而我没有 GUI 可点，只能看日志。
 */
const PROBE = `<!doctype html>
<meta charset="utf-8">
<script>
(async () => {
  const send = (steps) => parent.postMessage({ __sandboxProbe: true, steps }, "*");
  const steps = [];

  const record = (name, value) => steps.push({ name, value: String(value) });

  // 1. 沙箱里能不能看到 Tauri 的东西
  record("typeof __TAURI_INTERNALS__", typeof window.__TAURI_INTERNALS__);
  record("typeof __TAURI_INTERNALS__.invoke", typeof window.__TAURI_INTERNALS__?.invoke);
  record("typeof __TAURI_INVOKE_KEY__", typeof window.__TAURI_INVOKE_KEY__);
  record("typeof window.ipc", typeof window.ipc);
  record("window.origin", window.origin);

  // 2. 把 __TAURI_INTERNALS__ 摊开看：它是什么、有哪些键
  try {
    const internals = window.__TAURI_INTERNALS__;
    record("__TAURI_INTERNALS__ 的键", Object.keys(internals || {}).join(",") || "（没有可枚举键）");
    record("own property 名字", Object.getOwnPropertyNames(internals || {}).join(",") || "（无）");
    record("typeof metadata", typeof internals?.metadata);
    record(
      "metadata 长什么样",
      (() => {
        try {
          return JSON.stringify(internals?.metadata);
        } catch (error) {
          return "取不到：" + error;
        }
      })(),
    );
  } catch (error) {
    record("摊开 __TAURI_INTERNALS__", "失败：" + error);
  }

  // 3. 真去调命令 —— 这是底线。**必须把失败原因原样带回来**，不能只看「失败」两个字。
  const tryInvoke = async (label, command, args) => {
    try {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== "function") {
        record(label, "没有 invoke 函数");
        return;
      }
      const result = await invoke(command, args);
      record(label, "！！！可达：" + JSON.stringify(result) + " —— 方案作废");
    } catch (error) {
      let detail;
      try {
        detail = typeof error === "string" ? error : JSON.stringify(error);
      } catch (inner) {
        detail = String(error);
      }
      record(label, "失败：name=" + (error && error.name) + " message=" + (error && error.message) + " 原文=" + detail);
    }
  };

  await tryInvoke("invoke app_name（无参）", "app_name");
  await tryInvoke("invoke update_endpoint（无参）", "update_endpoint");
  await tryInvoke("invoke app_name（空对象参）", "app_name", {});
  await tryInvoke("invoke 不存在的命令", "definitely_not_a_command");

  // 4. 能不能读父窗口（同源的话就说明 origin 没被隔离）
  try {
    void parent.document.title;
    record("读 parent.document", "可以 —— origin 没隔离！");
  } catch (error) {
    record("读 parent.document", "被挡（符合预期）");
  }

  // 5. 能不能 fetch 应用自己 origin 下的东西（opaque origin 应该被 CORS 拒）
  try {
    const response = await fetch(location.origin + "/index.html");
    record("fetch 应用 origin 的资源", "拿到了 " + response.status + " —— 出乎意料");
  } catch (error) {
    record("fetch 应用 origin 的资源", "被拒（符合预期）：" + (error && error.message));
  }

  // 6. 内联 module 能不能跑
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "module";
      script.textContent = "window.__inlineModuleOk = true";
      script.onerror = () => reject(new Error("script.onerror"));
      document.body.appendChild(script);
      setTimeout(resolve, 50);
    });
    record("内联 <script type=module>", window.__inlineModuleOk ? "执行了" : "没执行");
  } catch (error) {
    record("内联 <script type=module>", "失败：" + error.message);
  }

  // 7. blob Worker（决定 pdf.js 走 Worker 还是主线程兜底）
  try {
    const url = URL.createObjectURL(new Blob(["self.onmessage=()=>self.postMessage(1)"], { type: "text/javascript" }));
    const worker = new Worker(url);
    await new Promise((resolve, reject) => {
      worker.onmessage = resolve;
      worker.onerror = (e) => reject(new Error(e.message || "worker error"));
      worker.postMessage(0);
      setTimeout(() => reject(new Error("超时")), 1000);
    });
    record("blob: Worker", "可用");
  } catch (error) {
    record("blob: Worker", "不可用：" + error.message);
  }

  // 8. postMessage 传 ArrayBuffer（PDF 字节要走这条）
  try {
    const buffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    parent.postMessage({ __sandboxProbe: true, echo: buffer }, "*");
    record("postMessage 传 ArrayBuffer", "已发出");
  } catch (error) {
    record("postMessage 传 ArrayBuffer", "失败：" + error.message);
  }

  send(steps);
})();
<\/script>`;

/**
 * 只在开发模式、且 URL 上带了 `?sandboxProbe=1` 时才挂载。
 *
 * 留着它是为了**换平台时能再验一遍**（macOS / Linux 的窗口 origin 是自定义 scheme，
 * 行为可能与 Windows 不同）。平时不挂 —— 它会在每个窗口里建一个 iframe 跑探针，
 * 白白刷日志。
 */
export function sandboxProbeEnabled(): boolean {
  return import.meta.env.DEV && window.location.search.includes("sandboxProbe=1");
}

export function SandboxProbe() {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const navigated = useRef(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // 只认我们自己那个帧。
      if (event.source !== frameRef.current?.contentWindow) return;

      const data = event.data as { __sandboxProbe?: boolean; steps?: unknown; echo?: unknown };

      if (data?.__sandboxProbe && Array.isArray(data.steps)) {
        console.error("[sandbox-probe] ===== 结果开始 =====");
        for (const step of data.steps as { name: string; value: string }[]) {
          console.error(`[sandbox-probe] ${step.name} → ${step.value}`);
        }
        console.error("[sandbox-probe] ===== 结果结束 =====");
      }

      if (data?.__sandboxProbe && data.echo instanceof ArrayBuffer) {
        console.error(`[sandbox-probe] ArrayBuffer 往返成功，${data.echo.byteLength} 字节`);
      }

      if (data?.__sandboxProbe && Array.isArray(data.steps) && !navigated.current) {
        navigated.current = true;
        // 最后一关：**让帧自己导航到应用 origin**，再看它还算不算沙箱。
        // 若沙箱标志不跨导航保留，帧就会变成与应用同源 —— 那样 origin 检查就能过、
        // IPC 就可达了，方案作废。规范说沙箱标志是跟着浏览上下文走的（永久 opaque），
        // 但这一条是整个方案的命门，必须实测。
        const frame = frameRef.current;
        if (!frame) return;

        // 挑一个同源但不是应用的地址：Vite 会把 .tsx 处理成 JS 返回，
        // 帧里只会把它当文本显示，不会把整个应用再启动一遍（免得刷屏）。
        frame.addEventListener(
          "load",
          () => {
            let verdict;
            try {
              void frame.contentWindow?.document;
              verdict = "能读到 document —— 与应用同源了，沙箱没保住！方案作废";
            } catch (error) {
              verdict = "读不到（opaque 保住了）：" + String((error as Error)?.name ?? error);
            }
            console.error("[sandbox-probe] 自导航到应用 origin 之后：" + verdict);
          },
          { once: true },
        );
        frame.src = location.origin + "/src/dev/SandboxProbe.tsx";
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={frameRef}
      title="sandbox-probe"
      sandbox="allow-scripts"
      srcDoc={PROBE}
      style={{ width: 1, height: 1, opacity: 0, position: "fixed", pointerEvents: "none" }}
    />
  );
}
