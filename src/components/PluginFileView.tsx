import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileType } from "../features/workspace/fileTypes";
import { loadViewDocument } from "../features/plugins/viewAssets";
import { readExternalFileBytes } from "../features/notes/api";
import { readWorkspaceFileBytes } from "../features/workspace/api";
import { PluginView } from "./PluginView";
import { showToast } from "./Toast";

/**
 * 把插件视图接到一个具体文件上：读出视图的 srcdoc、按需喂字节、转发消息。
 *
 * 沙箱边界在 `PluginView` 那一层（`sandbox="allow-scripts"`），这里只负责搬运。
 */

interface PluginFileViewProps {
  path: string;
  type: FileType;
}

/** 视图里的深浅色。取当前的 `data-theme`，视图自己按它调样式。 */
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function PluginFileView({ path, type }: PluginFileViewProps) {
  const { t } = useTranslation();
  const [document, setDocument] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setError(null);

    void loadViewDocument(type)
      .then((loaded) => {
        if (!cancelled) setDocument(loaded);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [type]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-[12px] text-ink-ghost">
        {t("main.view.loadFailed", {
          message: error,
          defaultValue: "这个文件的视图加载失败：{{message}}",
        })}
      </div>
    );
  }

  if (!document) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-ink-ghost">
        {t("common.loading", { defaultValue: "加载中…" })}
      </div>
    );
  }

  const name = path.split(/[\\/]/).pop() ?? path;

  return (
    <PluginView
      document={document}
      name={name}
      path={path}
      theme={currentTheme()}
      // 工作区里的文件优先走工作区通道；从「打开方式」进来的不在任何工作区里，会退回外部通道。
      loadBytes={() =>
        readWorkspaceFileBytes(path).catch(() => readExternalFileBytes(path))
      }
      // 批注存储（阶段 3）还没接上。现在没有插件注册视图，这条路径不会被执行到。
      loadAnnotations={async () => null}
      onSaveAnnotations={() => {
        console.warn("[plugin-view] 批注存储尚未接入，这次保存被丢弃");
      }}
      onToast={showToast}
      onLog={(level, message) => {
        // 视图里的日志走宿主控制台 —— 只有 error 会被 Vite 转发出来。
        if (level === "error") console.error(`[plugin-view] ${message}`);
        else if (level === "warn") console.warn(`[plugin-view] ${message}`);
        else console.info(`[plugin-view] ${message}`);
      }}
    />
  );
}
