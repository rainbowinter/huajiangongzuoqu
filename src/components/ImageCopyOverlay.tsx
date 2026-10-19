import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { copyFilePaths } from "../features/clipboard/api";
import { getErrorMessage } from "../features/notes/api";
import { POPUP_VIEWPORT_MARGIN, useViewportPopupPosition } from "./popupPosition";

/**
 * 图片的「复制原图」入口。
 *
 * 与表格 / 代码块那个 `CopyButton` 的区别：这里写的是**系统剪贴板的文件列表**
 *（Windows 的 `CF_HDROP`）+ 路径文本，而不是 `navigator.clipboard.writeText`。
 * 于是粘到资源管理器 / Word 得到原文件，粘回花笺的编辑器则得到 `![](路径)`。
 *
 * 为什么不把按钮直接塞进 `<img>`：图片本身是替换元素，里面放不了子节点。调用方给外层
 * 加 `relative group`，这里用绝对定位贴在右上角。
 */
export function ImageCopyButton({ path }: { path: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = useCallback(
    async (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await copyFilePaths([path]);
        setState("copied");
      } catch (error) {
        console.warn("[image] 复制图片失败", error, getErrorMessage(error));
        setState("failed");
      }
    },
    [path],
  );

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [state]);

  let label: string = t("markdown.copyImage", { defaultValue: "复制图片" });
  if (state === "copied") label = t("markdown.copied", { defaultValue: "已复制" });
  if (state === "failed") label = t("markdown.copyFailed", { defaultValue: "复制失败" });

  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={copy}
      className="image-copy-button absolute top-2 right-2 z-10 px-1.5 py-0.5 rounded text-[10px] font-mono bg-paper-deep/30 text-ink-ghost opacity-0 group-hover:opacity-100 hover:bg-paper-deep/50 hover:text-ink-soft transition-all cursor-pointer"
    >
      {label}
    </button>
  );
}

interface MenuPosition {
  x: number;
  y: number;
}

/**
 * 图片右键菜单的状态与渲染。
 *
 * 菜单 `createPortal` 到 `document.body`：预览区本身是 `overflow-auto`，留在里面会被
 * 裁掉（与标题栏那一类浮层同一个问题）。
 */
export function useImageCopyMenu(path: string | null) {
  const { t } = useTranslation();
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const openMenu = useCallback(
    (event: MouseEvent) => {
      if (!path) return;
      event.preventDefault();
      event.stopPropagation();
      setPosition({ x: event.clientX, y: event.clientY });
    },
    [path],
  );

  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    document.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [position]);

  const menu = path && position ? (
    <ImageCopyMenu
      path={path}
      position={position}
      label={t("markdown.copyImage", { defaultValue: "复制图片" })}
      onClose={() => setPosition(null)}
    />
  ) : null;

  return { openMenu, menu };
}

function ImageCopyMenu({
  path,
  position,
  label,
  onClose,
}: {
  path: string;
  position: MenuPosition;
  label: string;
  onClose: () => void;
}) {
  const { popupRef, popupPosition } = useViewportPopupPosition(position, path);

  const copy = useCallback(async () => {
    try {
      await copyFilePaths([path]);
    } catch (error) {
      console.warn("[image] 复制图片失败", error, getErrorMessage(error));
    }
    onClose();
  }, [path, onClose]);

  return createPortal(
    <div
      ref={popupRef}
      role="menu"
      className="popup-menu fixed z-[9999] min-w-[132px] py-1 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg shadow-lg animate-menu-enter select-none"
      style={{
        left: popupPosition?.x ?? position.x,
        top: popupPosition?.y ?? position.y,
        maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
        maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => void copy()}
        className="context-menu-item w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
      >
        {label}
      </button>
    </div>,
    document.body,
  );
}
