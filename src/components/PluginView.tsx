import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { HostMessage } from "../features/plugins/viewBridge";
import { parseViewMessage } from "../features/plugins/viewBridge";

/**
 * 插件视图：把插件自己的界面跑在一个**沙箱 iframe** 里。
 *
 * ## ⚠️ sandbox 只能是 `allow-scripts`
 *
 * 加 `allow-same-origin`（或干脆不给 sandbox）会让帧拿到真实 origin —— 官方安全公告
 * GHSA-57fm-592m-34r7 指出 **Windows 上当 iframe 与窗口同源时可达到 IPC**，那就是安全回退。
 *
 * 只给 `allow-scripts` 时帧是**永久 opaque origin**，它**通不过 Tauri 每一次调用的 origin
 * 检查**（实测结论与依据见 `Docs/plugin-view-sandbox.md` —— 注意别用 `typeof
 * __TAURI_INTERNALS__` 去判断，那个对象**确实在**，判据是「调不通」）。
 *
 * `PluginView.test.tsx` 里有一条测试把这个字符串**逐字**钉住了，改它之前先看那份文档。
 */

/** 宿主递给外部的那个口子：工具栏按钮点了要往视图里下命令。 */
export interface PluginViewApi {
  post: (message: HostMessage) => void;
}

/** 视图加载完之前先攒着几条命令 —— 攒不下就直接丢，别让它无限长。 */
const MAX_QUEUED_COMMANDS = 32;

interface PluginViewProps {
  /** 宿主拼好的 srcdoc。 */
  document: string;
  /** 送给视图的文件信息。 */
  name: string;
  path: string;
  theme: "light" | "dark";
  /** 应用主题的调色板（解析后的值）。视图是独立文档，拿不到宿主的 CSS 变量。 */
  tokens: Record<string, string>;
  /** 取文件字节（PDF 这类二进制走这条）。 */
  loadBytes: () => Promise<ArrayBuffer>;
  /**
   * 往这个视图里并了资源的插件名。打开文件时按名字各推一份它们已存的数据 ——
   * 一个视图里可能同时跑着两个插件的代码，各要各的。
   */
  dataPlugins: readonly string[];
  /** 取某个插件在这个文件上存的数据。 */
  loadData: (plugin: string) => Promise<unknown>;
  /** 某个插件要存数据。宿主负责校验与落盘。 */
  onSaveData: (plugin: string, data: unknown) => void;
  /** 视图报上来的工具栏状态。 */
  onState: (values: Record<string, string>, pressed: string[]) => void;
  /** 宿主往视图下命令的口子，由宿主工具栏填。 */
  apiRef?: RefObject<PluginViewApi | null>;
  onToast: (message: string) => void;
  onLog: (level: "info" | "warn" | "error", message: string) => void;
}

export function PluginView(props: PluginViewProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** 视图回过 `ready` 没有 —— 没有的话它还没装上 `onCommand`，消息发过去就是扔了。 */
  const readyRef = useRef(false);
  const queuedRef = useRef<HostMessage[]>([]);
  /** 发消息的口子。挂载时由下面的 effect 填上，theme 变化那个 effect 要用它。 */
  const postRef = useRef<((message: HostMessage) => void) | null>(null);

  // 回调与参数放进 ref：消息监听只订阅一次，不必因为父组件重渲染而反复解绑重绑。
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    /** 往帧里发消息。opaque origin 下 targetOrigin 只能是 `"*"` —— 安全性由收信侧的
     * `event.source` 校验保证，见下面。 */
    const post = (message: HostMessage) => {
      frameRef.current?.contentWindow?.postMessage(message, "*");
    };

    /**
     * 工具栏按钮点了。
     *
     * 视图要**先把插件那坨 js 解析完**才会回 `ready`（pdf.js 压缩包将近 500KB，不是一瞬间
     * 的事），而上面那排控件从进页面起就能点 —— 不排队的话，刚打开文件那几秒里点「+」
     * 会一点反应都没有。所以 ready 之前的命令先攒着，`init` 发出去之后再补发。
     */
    const postCommand = (message: HostMessage) => {
      if (readyRef.current) {
        post(message);
        return;
      }
      if (queuedRef.current.length < MAX_QUEUED_COMMANDS) queuedRef.current.push(message);
    };

    // 工具栏拿到的就是这个口子。
    const api: PluginViewApi = { post: postCommand };
    if (props.apiRef) props.apiRef.current = api;
    postRef.current = postCommand;

    const sendDocument = () => {
      void latest.current
        .loadBytes()
        .then((bytes) => post({ t: "document", bytes }))
        .catch((error) =>
          post({ t: "documentError", message: error instanceof Error ? error.message : String(error) }),
        );
    };

    const onMessage = (event: MessageEvent) => {
      // ⚠️ 这一条不能省：页面上可能有别的 iframe（包括别的插件的视图），
      // 不认来源的话任何一张都能冒充这个视图来指挥宿主。
      if (event.source !== frameRef.current?.contentWindow) return;

      const message = parseViewMessage(event.data);
      if (!message) return;

      switch (message.t) {
        case "ready": {
          readyRef.current = true;
          post({
            t: "init",
            name: latest.current.name,
            path: latest.current.path,
            theme: latest.current.theme,
            tokens: latest.current.tokens,
          });
          // 顺序要紧：init 在前，用户早先点的那几下在后。
          const queued = queuedRef.current;
          queuedRef.current = [];
          for (const command of queued) post(command);
          sendDocument();
          // 按插件各推一份。失败当作「没存过」——打不开一份旁挂数据不该让视图起不来。
          for (const plugin of latest.current.dataPlugins) {
            void latest.current
              .loadData(plugin)
              .then((data) => post({ t: "data", plugin, data }))
              .catch(() => post({ t: "data", plugin, data: null }));
          }
          break;
        }

        case "requestDocument":
          sendDocument();
          break;

        case "saveData":
          latest.current.onSaveData(message.plugin, message.data);
          break;

        case "state":
          latest.current.onState(message.values, message.pressed);
          break;

        case "toast":
          latest.current.onToast(message.message);
          break;

        case "log":
          latest.current.onLog(message.level, message.message);
          break;
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      postRef.current = null;
      // 帧没了，工具栏手里的那个口子也就作废了 —— 留着会往一张空窗口上发消息。
      if (props.apiRef?.current === api) props.apiRef.current = null;
    };
  }, []);

  /**
   * 主题变了就告诉视图。
   *
   * 两种情况不发：**首次**（那一趟 `init` 已经把 theme / tokens 带过去了，再发一条纯属多余，
   * 还可能抢在 `init` 之前到），以及**值没变**（开发模式下 StrictMode 会把挂载跑两遍，
   * 只按「第一次」判断的话第二遍会白发一条）。
   *
   * `tokens` 比的是对象**同一性**：它由 `PluginFileView` 的 `useViewTheme` 保管，
   * 值没变时就是同一个对象。
   */
  const sentThemeRef = useRef<{ theme: string; tokens: Record<string, string> } | null>(null);
  useEffect(() => {
    const previous = sentThemeRef.current;
    sentThemeRef.current = { theme: props.theme, tokens: props.tokens };
    if (!previous) return;
    if (previous.theme === props.theme && previous.tokens === props.tokens) return;
    postRef.current?.({ t: "theme", theme: props.theme, tokens: props.tokens });
  }, [props.theme, props.tokens]);

  return (
    <iframe
      ref={frameRef}
      title="插件视图"
      // ⚠️ 逐字如此，别加 allow-same-origin。理由见文件头。
      sandbox="allow-scripts"
      srcDoc={props.document}
      // flex-1：上面可能还有一排宿主渲染的工具栏（`view.toolbar`）。
      className="w-full flex-1 min-h-0 border-0 bg-cloud"
    />
  );
}
