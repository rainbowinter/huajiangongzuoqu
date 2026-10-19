import type { FilePreviewKind } from "../features/workspace/fileTypes";

/**
 * 文件类型的小图标。目录树（列表 / 图标两种视图）与标签页共用这一份。
 *
 * 为什么不再用 `PY` / `CSV` 那种文字徽章：列表与标签页只有十几像素高，两三个字母
 * 挤在里面更像噪音；一个形状稳定的图标更容易一眼分辨。卡片视图仍保留徽章 —— 那里
 * 横向空间够，徽章还带着文件类型的强调色。
 *
 * 颜色由调用方给（文件类型注册表里的 `type.color`）；不给就跟随 `currentColor`，
 * 于是标签页里能自然跟着激活态变色。
 */
export type FileKind = FilePreviewKind | "note" | "folder" | "doc";

export function FileKindIcon({
  kind,
  size = 14,
  color,
  className,
}: {
  kind: FileKind;
  size?: number;
  color?: string | null;
  className?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    style: color ? { color } : undefined,
    "aria-hidden": true,
  };

  switch (kind) {
    case "folder":
      return (
        <svg {...common}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "image":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.4" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case "media":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <polygon points="10 8 16 12 10 16 10 8" />
        </svg>
      );
    case "code":
      return (
        <svg {...common}>
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case "table":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
        </svg>
      );
    case "markdown":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M8 12v6M8 18l-2-2M8 18l2-2" />
        </svg>
      );
    case "note":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M8 13h8M8 17h5" />
        </svg>
      );
    case "doc":
      // 摊开的书 —— 只读说明文档（「关于」里的几篇、插件 README）。
      return (
        <svg {...common}>
          <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2H11v18H4.5A2.5 2.5 0 0 0 2 22.5z" />
          <path d="M22 4.5A2.5 2.5 0 0 0 19.5 2H13v18h6.5a2.5 2.5 0 0 1 2.5 2.5z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      );
  }
}
