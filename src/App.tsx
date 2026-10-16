import { useEffect } from "react";
import "./App.css";
// 全局样式表**不再从源码 import** —— 它改成了运行时注入：`<数据目录>/styles/*.css`
// 全部注入每个窗口，改完保存约两秒后自动生效，不必重新构建。
//
// 源码里那份 `src/styles/custom.css` 现在只是**模板**：首次运行时被复制成
// `<数据目录>/styles/custom.css`，之后一律以用户那份为准（升级不覆盖）。
// 详见 `src/features/styles/globalStyles.ts` 与 `src-tauri/src/styles.rs`。
import { installGlobalStyles } from "./features/styles/globalStyles";
import { ContextMenuProvider } from "./components/ContextMenu";
import { disposeListener } from "./components/listeners";
import { MainWindow } from "./components/MainWindow";
import { NotePad } from "./components/NotePad";
import { TileShowcase } from "./components/TileShowcase";
import { PluginPromptDialog } from "./components/PluginPromptDialog";
import { ToastContainer } from "./components/Toast";
import { tabToIndentListener } from "indent-textarea";
import { getConfig } from "./features/settings/api";
import { restoreCodeFont } from "./features/settings/codeFont";
import { applyRenderColors } from "./features/settings/renderColors";
import { applyTheme, watchSystemTheme } from "./features/settings/theme";
import { handleUiZoomKey, restoreUiZoom } from "./features/settings/uiZoom";
import { syncCodeTheme } from "./features/markdown/codeThemes";
import type { AppConfig, ThemeOption } from "./features/settings/types";
import { getInitialRoute } from "./features/windows/windowRoutes";
import { syncLanguage } from "./locales";
import { listen } from "@tauri-apps/api/event";
import { SandboxProbe, sandboxProbeEnabled } from "./dev/SandboxProbe";

/** 应用主题色到 document 属性 */
function applyAccent(accent?: string) {
  document.documentElement.setAttribute("data-accent", accent || "green");
}

function App() {
  const route = getInitialRoute();
  const activeView = route.view;

  useEffect(() => {
    let cleanup = () => {};
    getConfig()
      .then((config) => {
        const theme = (config.theme || "system") as ThemeOption;
        applyTheme(theme);
        cleanup = watchSystemTheme(theme);
        applyAccent(config.accentColor);
        document.documentElement.style.setProperty(
          "--tab-indent-size",
          String(config.tabIndentSize ?? 2),
        );
        applyRenderColors(config);
        void syncLanguage(config.locale);
      })
      .catch(() => {});
    return () => cleanup();
  }, []);

  useEffect(() => {
    let themeCleanup = () => {};
    const unlisten = listen<AppConfig>("config-changed", (event) => {
      const theme = (event.payload.theme || "system") as ThemeOption;
      applyTheme(theme);
      themeCleanup();
      themeCleanup = watchSystemTheme(theme);
      applyAccent(event.payload.accentColor);
      document.documentElement.style.setProperty(
        "--tab-indent-size",
        String(event.payload.tabIndentSize ?? 2),
      );
      applyRenderColors(event.payload);
      void syncLanguage(event.payload.locale);
    });
    return () => {
      themeCleanup();
      disposeListener(unlisten);
    };
  }, []);

  /**
   * 界面缩放（Ctrl + `=` / `-` / `0`）。
   *
   * 挂在 window 上，所以主窗口、小窗、磁贴**各自**都生效 —— 缩放是 WebView 级别的，
   * 每个窗口一份，恰好符合直觉。
   */
  useEffect(() => {
    restoreUiZoom();

    const onKeyDown = (event: KeyboardEvent) => {
      if (handleUiZoomKey(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * 代码字体。与界面缩放同理，这是**每个 WebView 各自的显示偏好**，存在 localStorage
   * 而不是 `AppConfig` 里，所以不跟 `config-changed` 走，各窗口开机自己恢复一次。
   */
  useEffect(() => {
    restoreCodeFont();
  }, []);

  /**
   * 全局样式表：`<数据目录>/styles/` —— `custom.css` 常开，其余的在「样式」面板里开关。
   *
   * **哪几份生效由后端说了算**（`styles::applied_names`），这里只认它给的 `applied`。
   * 挂在这里是因为 `App` 是主窗口 / 小窗 / 磁贴**共用的外壳** —— 一处接线三个视图全覆盖。
   * 每个窗口各注入自己的一份（`document.head` 本来就各窗口独立）。
   * 文件改动由 Rust 侧的轮询广播出来，这里只管收到就重注入。
   */
  useEffect(() => installGlobalStyles(), []);

  /**
   * 代码着色主题。放在 App 而不是 MainWindow：所有窗口共用同一套 `.hljs-*` 类名，
   * 主题是进程内全局的，小窗与磁贴也得有样式。
   *
   * `data-theme` 是属性，应用主题切换时盯它即可（浅色 ↔ 深色要换主题）。
   */
  useEffect(() => {
    syncCodeTheme();

    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(syncCodeTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleTab = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (target.dataset.tabIndent !== "true") return;
      tabToIndentListener(event);
    };
    window.addEventListener("keydown", handleTab, true);
    return () => window.removeEventListener("keydown", handleTab, true);
  }, []);

  useEffect(() => {
    const isWindows =
      navigator.userAgent.includes("Windows") || navigator.platform.toLowerCase().startsWith("win");
    if (!isWindows) return;

    const preventSystemMenu = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "Space") {
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", preventSystemMenu, true);
    return () => document.removeEventListener("keydown", preventSystemMenu, true);
  }, []);

  return (
    <ContextMenuProvider>
      <div className="app-window-shell h-screen font-body text-ink overflow-hidden">
        {activeView === "main" ? (
          <MainWindow />
        ) : activeView === "notepad" ? (
          <NotePad initialNoteId={route.noteId} />
        ) : (
          <TileShowcase noteId={route.noteId} />
        )}
        <ToastContainer />
        <PluginPromptDialog />
        {/* 沙箱探针：验证「插件视图」的隔离前提。平时不挂，只在开发模式且 URL 带
            `?sandboxProbe=1` 时跑（见 src/dev/SandboxProbe.tsx 与 Docs/plugin-view-sandbox.md）。 */}
        {sandboxProbeEnabled() ? <SandboxProbe /> : null}
      </div>
    </ContextMenuProvider>
  );
}

export default App;
