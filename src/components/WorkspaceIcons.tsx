/**
 * 工作区图标。
 *
 * 用户加了好几个工作文件夹之后，活动栏那一列**全靠一个文件夹图标**，几个都叫 `src` /
 * `styles` 就分不清哪个是哪个了。所以每一格可以右键换成别的图标（配置里存
 * `workspaceIcons: { <路径>: <id> }`）。
 *
 * **默认是 `folder`，认不出的 id 也回落到它** —— 这样以后删掉某个图标不会让老配置变坏，
 * 顶多那几格回到默认。名单只在**前端**这一份，Rust 那边只校验 id 的形状
 *（`workspace_set_icon`），不维护第二份名单、免得两边对不上。
 *
 * ⚠️ 尺寸**由调用方给**：活动栏里是 17px，右键菜单里的候选是小一号。别在这里写死。
 */
import type { ReactNode } from "react";

export interface WorkspaceIconSpec {
  id: string;
  /** 右键菜单里那排小格子的 `title`。 */
  label: string;
}

/** 可供选择的图标。第一项就是默认值。 */
export const WORKSPACE_ICONS: readonly WorkspaceIconSpec[] = [
  { id: "folder", label: "文件夹" },
  { id: "code", label: "代码" },
  { id: "styles", label: "样式" },
  { id: "docs", label: "文档" },
  { id: "data", label: "数据" },
  { id: "image", label: "图片" },
  { id: "star", label: "星标" },
  { id: "terminal", label: "终端" },
];

export const DEFAULT_WORKSPACE_ICON = "folder";

/** id → 图形。都写成 `currentColor` 描边，跟主题色走。 */
const GLYPHS: Record<string, ReactNode> = {
  folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  code: (
    <>
      <path d="m8 6-5 6 5 6" />
      <path d="m16 6 5 6-5 6" />
    </>
  ),
  // 一滴颜料 —— 比调色盘那种一堆小圆点在十几像素下清楚得多。
  styles: <path d="M12 3s6 6.6 6 10.6a6 6 0 0 1-12 0C6 9.6 12 3 12 3z" />,
  docs: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  data: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </>
  ),
  star: <polygon points="12 2 15.1 8.6 22 9.5 17 14.4 18.2 21.4 12 18 5.8 21.4 7 14.4 2 9.5 8.9 8.6" />,
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>
  ),
};

/** 这个 id 认不认识。认不出就画默认那个。 */
export function isKnownWorkspaceIcon(id: string | undefined): boolean {
  return typeof id === "string" && id in GLYPHS;
}

/**
 * 画一枚工作区图标。
 *
 * `id` 传 `undefined`、空串、或者一个不认识的 id —— 都画默认的文件夹图标。
 */
export function WorkspaceIcon({ id, size = 17 }: { id?: string; size?: number }) {
  const key = isKnownWorkspaceIcon(id) ? (id as string) : DEFAULT_WORKSPACE_ICON;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[key]}
    </svg>
  );
}
