import { Fragment, type CSSProperties, type DragEvent, type MouseEvent } from "react";

/**
 * 目录行：与笔记列表里的「分类」表头同一套观感 —— 折叠箭头 + 文件夹图标 + 名称 + 计数。
 *
 * 为什么目录不也用卡片：目录与文件是两种东西。目录是容器、点它是展开而不是打开，
 * 用表头的样式能把"这是可以展开的一层"和"这是一个文件"直接区分开，不必靠读文字。
 */
interface ExplorerFolderRowProps {
  name: string;
  open: boolean;
  /** 缩进层级（根目录为 0）。 */
  depth?: number;
  /** 子项数量；尚未加载时为 undefined。 */
  count?: number;
  onToggle: () => void;
}

export function ExplorerFolderRow({
  name,
  open,
  depth = 0,
  count,
  onToggle,
}: ExplorerFolderRowProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={name}
      className="w-full flex items-center gap-1.5 py-1.5 my-0.5 rounded-lg text-left transition-colors duration-200 cursor-pointer select-none hover:bg-bamboo/10"
      style={{ paddingLeft: 10 + depth * 12, paddingRight: 10 }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`text-bamboo/50 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-bamboo/50 shrink-0"
      >
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <span className="text-[11px] text-bamboo/70 font-medium truncate">{name}</span>
      {count !== undefined ? (
        <span className="text-[9px] text-bamboo/40 font-mono ml-auto shrink-0">{count}</span>
      ) : null}
    </button>
  );
}

/**
 * 侧栏资源管理器里的一张卡片。
 *
 * 为什么要有这个组件：笔记卡片的这份 JSX 原先在 `MainWindow.tsx` 里**逐字重复了两遍**
 * （未分类区一遍、分类分组内一遍），只差内边距与圆角。文件读取器要在同一个侧栏里显示
 * 文件卡片，而且要求"风格与笔记一致"——如果不去重，就会变成三份、四份拷贝，风格一致
 * 只能靠人工维持，迟早漂移。
 *
 * 组件刻意保持"哑"：标题、日期、字数都由调用方算好传进来，组件不认识 `Note` 也不认识
 * 文件。这样它同时服务两者，也不需要为任何一边引入依赖。
 */
export interface ExplorerItemProps {
  title: string;
  /** 右上角的短标记：笔记是日期，文件可以是大小或修改时间。 */
  meta?: string;
  /** 第二行描述。 */
  subtitle?: string;
  /** 描述文字最多显示几行。笔记是两行；工作区文件按需求只留一行。 */
  subtitleLines?: 1 | 2;
  /** 第三行的小字信息，用 `·` 分隔。 */
  details?: string[];
  /**
   * 强调色。选中的左侧竖条、标题、以及 `badge` 底色都用它。
   * 不传则取主题强调色（`--color-bamboo`），也就是笔记卡片的既有观感。
   */
  accent?: string | null;
  /** 标题前的短标签，例如文件类型的 `PY` / `CSV`。笔记不传。 */
  badge?: string | null;
  selected?: boolean;
  hovered?: boolean;
  /** 嵌在分类分组里的紧凑变体：更小的圆角、更窄的内边距、左右留 4px。 */
  inset?: boolean;
  /** 缩进层级。工作区的目录树用；笔记列表不传。 */
  depth?: number;
  draggable?: boolean;
  onSelect?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  onHoverChange?: (hovered: boolean) => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
}

const DEFAULT_ACCENT = "var(--color-bamboo)";

export function ExplorerItem({
  title,
  meta,
  subtitle,
  subtitleLines = 2,
  details,
  accent,
  badge,
  selected = false,
  hovered = false,
  inset = false,
  depth = 0,
  draggable = false,
  onSelect,
  onContextMenu,
  onHoverChange,
  onDragStart,
}: ExplorerItemProps) {
  const accentColor = accent || DEFAULT_ACCENT;

  // `inset` 已经把左右各留了 4px（mx-1 + width: calc(100% - 8px)）。嵌套时要在这个
  // 基础上再往右推 `depth * 12`，宽度同步减掉同样多，否则卡片会溢出容器。
  const offset = depth * 12;
  const layoutStyle: CSSProperties = inset
    ? { width: `calc(100% - ${8 + offset}px)`, ...(offset ? { marginLeft: 4 + offset } : {}) }
    : {};

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
      className={`w-full text-left transition-all duration-[600ms] cursor-pointer group relative ${
        inset ? "rounded-lg mx-1 px-2.5 py-2" : "rounded-xl px-3 py-2.5"
      } ${selected ? "bg-bamboo-mist/70" : hovered ? "bg-paper-warm/70" : "bg-transparent"}`}
      style={inset ? layoutStyle : undefined}
    >
      <div
        className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full transition-all duration-[600ms] ${
          selected ? "h-5 opacity-100" : "h-0 opacity-0"
        }`}
        // 60% 透明度与改造前的 `bg-bamboo/60` 等价；换成强调色的十六进制后，
        // 用 color-mix 现场算出同样的透明度，观感才一致。
        style={{ backgroundColor: `color-mix(in oklab, ${accentColor} 60%, transparent)` }}
      />

      <div className="flex items-baseline justify-between mb-0.5">
        <span
          className={`text-[13px] font-display font-medium truncate pr-2 transition-colors flex items-center gap-1.5 min-w-0 ${
            selected ? "" : "text-ink-soft"
          }`}
          style={selected ? { color: accentColor } : undefined}
        >
          {badge ? (
            <span
              className="shrink-0 px-1 py-px rounded text-[9px] font-mono leading-none"
              style={{
                backgroundColor: `color-mix(in oklab, ${accentColor} 18%, transparent)`,
                color: accentColor,
              }}
            >
              {badge}
            </span>
          ) : null}
          <span className="truncate">{title}</span>
        </span>
        {meta ? (
          <span className="text-[10px] text-ink-ghost font-mono tabular-nums shrink-0">{meta}</span>
        ) : null}
      </div>

      {subtitle ? (
        <p
          className={`text-[11px] text-ink-ghost leading-relaxed group-hover:text-ink-faint transition-colors ${
            subtitleLines === 1 ? "truncate" : "line-clamp-2"
          }`}
        >
          {subtitle}
        </p>
      ) : null}

      {details && details.length > 0 ? (
        <div className="flex items-center gap-2 mt-1">
          {details.map((detail, index) => (
            <Fragment key={index}>
              {index > 0 ? <span className="text-[10px] text-ink-ghost/40">·</span> : null}
              <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">{detail}</span>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
