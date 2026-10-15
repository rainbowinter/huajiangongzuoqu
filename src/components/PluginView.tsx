import { useEffect, useRef } from "react";
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

interface PluginViewProps {
  /** 宿主拼好的 srcdoc。 */
  document: string;
  /** 送给视图的文件信息。 */
  name: string;
  path: string;
  theme: "light" | "dark";
  /** 取文件字节（PDF 这类二进制走这条）。 */
  loadBytes: () => Promise<ArrayBuffer>;
  /** 取已存的批注。 */
  loadAnnotations: () => Promise<unknown>;
  /** 视图要存批注。宿主负责校验权限与落盘。 */
  onSaveAnnotations: (data: unknown) => void;
  onToast: (message: string) => void;
  onLog: (level: "info" | "warn" | "error", message: string) => void;
}

export function PluginView(props: PluginViewProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // 回调与参数放进 ref：消息监听只订阅一次，不必因为父组件重渲染而反复解绑重绑。
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    /** 往帧里发消息。opaque origin 下 targetOrigin 只能是 `"*"` —— 安全性由收信侧的
     * `event.source` 校验保证，见下面。 */
    const post = (message: HostMessage) => {
      frameRef.current?.contentWindow?.postMessage(message, "*");
    };

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
        case "ready":
          post({
            t: "init",
            name: latest.current.name,
            path: latest.current.path,
            theme: latest.current.theme,
          });
          sendDocument();
          void latest.current
            .loadAnnotations()
            .then((data) => post({ t: "annotations", data }))
            .catch(() => post({ t: "annotations", data: null }));
          break;

        case "requestDocument":
          sendDocument();
          break;

        case "saveAnnotations":
          latest.current.onSaveAnnotations(message.data);
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
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={frameRef}
      title="插件视图"
      // ⚠️ 逐字如此，别加 allow-same-origin。理由见文件头。
      sandbox="allow-scripts"
      srcDoc={props.document}
      className="w-full h-full border-0 bg-cloud"
    />
  );
}
