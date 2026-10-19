import {
  Fragment,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

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
  /** 紧凑模式：只画箭头 + 文件夹图标 + 名称。 */
  compact?: boolean;
  /** 这一行是不是「当前焦点文件夹」（新建文件的默认落点）。 */
  focused?: boolean;
  /** 多选集合里的目录。 */
  multiSelected?: boolean;
  /** 给外壳用的 data 属性：框选与拖入定位都靠它。 */
  dataPath?: string;
  dataDrop?: string;
  /** hover 时出现的「在这里新建」按钮。不给就不渲染。 */
  onCreate?: () => void;
  /** 「+」按钮的提示文字。 */
  createTitle?: string;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function ExplorerFolderRow({
  name,
  open,
  depth = 0,
  count,
  compact = false,
  focused = false,
  multiSelected = false,
  dataPath,
  dataDrop,
  onCreate,
  createTitle,
  onToggle,
  draggable = false,
  onDragStart,
  onContextMenu,
}: ExplorerFolderRowProps) {
  return (
    <div
      data-workspace-path={dataPath}
      data-workspace-drop={dataDrop}
      className={`explorer-folder group w-full flex items-center my-0.5 rounded-lg text-left transition-colors duration-200 select-none hover:bg-bamboo/10${
        open ? " is-open" : ""
      }${focused ? " is-focused" : ""}${compact ? " is-compact" : ""}${
        multiSelected ? " is-multi-selected bg-bamboo-mist/45 ring-1 ring-inset ring-bamboo/20" : ""
      }`}
      style={{ paddingLeft: 10 + depth * 12, paddingRight: 8 }}
      draggable={draggable}
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
    >
      {/*
       * 外层是 div、里面才是 button：文件夹行右侧要挂一个 hover 才出现的「+」，
       * button 里面再嵌 button 是非法 HTML（浏览器会把内层拆出去）。
       */}
      <button
        type="button"
        onClick={onToggle}
        title={name}
        className={`explorer-folder-toggle flex items-center gap-1.5 flex-1 min-w-0 text-left cursor-pointer ${
          compact ? "py-1" : "py-1.5"
        }`}
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
      </button>

      {count !== undefined ? (
        <span className="explorer-folder-count text-[9px] text-bamboo/40 font-mono ml-1 shrink-0">
          {count}
        </span>
      ) : null}
      {onCreate ? (
        <button
          type="button"
          draggable={false}
          onClick={(event) => {
            event.stopPropagation();
            onCreate();
          }}
          title={createTitle ?? "在这里新建文件"}
          /*
           * **只有悬停这一行时才出现**（键盘聚焦时也显示，方便 Tab 过去）。
           * 目录树很窄，每行都挂一颗「+」会把文件名挤短；悬停再出来更安静。
           */
          className="explorer-folder-add ml-1 w-4 h-4 flex items-center justify-center rounded text-[12px] leading-none text-bamboo/50 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 hover:bg-bamboo/15 hover:text-bamboo transition-all cursor-pointer shrink-0"
        >
          +
        </button>
      ) : null}
    </div>
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
  /** 紧凑变体：只画「类型图标 + 标题」一行。工作区的列表模式用。 */
  compact?: boolean;
  /** 列表模式里的类型图标；不给时紧凑模式回落到 `badge`。 */
  leadingIcon?: ReactNode;
  /** 多选集合里的那一张卡片。 */
  multiSelected?: boolean;
  /** 给外壳用的 data 属性：框选与拖入定位都靠它。 */
  dataPath?: string;
  dataDrop?: string;
  draggable?: boolean;
  onSelect?: (event: MouseEvent<HTMLDivElement>) => void;
  /** 鼠标中键。用于「在新标签页中打开」。 */
  onAuxClick?: (event: MouseEvent<HTMLDivElement>) => void;
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
  compact = false,
  leadingIcon,
  multiSelected = false,
  dataPath,
  dataDrop,
  draggable = false,
  onSelect,
  onAuxClick,
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
      data-workspace-path={dataPath}
      data-workspace-drop={dataDrop}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onSelect}
      onAuxClick={(event) => {
        if (event.button === 1) onAuxClick?.(event);
      }}
      onContextMenu={onContextMenu}
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
      className={`explorer-item w-full text-left transition-all duration-[600ms] cursor-pointer group relative ${
        inset ? "rounded-lg mx-1" : "rounded-xl"
      } ${compact ? "is-compact px-2.5 py-1" : inset ? "px-2.5 py-2" : "px-3 py-2.5"} ${
        selected
          ? "is-selected bg-bamboo-mist/70"
          : multiSelected
            ? "is-multi-selected bg-bamboo-mist/45 ring-1 ring-inset ring-bamboo/20"
            : hovered
              ? "is-hovered bg-paper-warm/70"
              : "bg-transparent"
      }`}
      style={inset ? layoutStyle : undefined}
    >
      <div
        className={`explorer-item-accent absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full transition-all duration-[600ms] ${
          selected ? "h-5 opacity-100" : "h-0 opacity-0"
        }`}
        // 60% 透明度与改造前的 `bg-bamboo/60` 等价；换成强调色的十六进制后，
        // 用 color-mix 现场算出同样的透明度，观感才一致。
        style={{ backgroundColor: `color-mix(in oklab, ${accentColor} 60%, transparent)` }}
      />

      {compact ? (
        /* 紧凑模式：「类型图标 + 标题」一行，不显示日期、预览与大小。 */
        <div className="flex items-center gap-1.5 min-w-0">
          {leadingIcon ? (
            <span className="shrink-0 flex items-center" style={{ color: accentColor }}>
              {leadingIcon}
            </span>
          ) : badge ? (
            <span
              className="explorer-item-badge shrink-0 w-4 h-4 flex items-center justify-center rounded text-[8px] font-mono leading-none"
              style={{
                backgroundColor: `color-mix(in oklab, ${accentColor} 18%, transparent)`,
                color: accentColor,
              }}
            >
              {badge}
            </span>
          ) : null}
          <span
            className={`explorer-item-title text-[12px] font-display font-medium truncate transition-colors ${
              selected ? "" : "text-ink-soft"
            }`}
            style={selected ? { color: accentColor } : undefined}
          >
            {title}
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between mb-0.5">
            <span
              className={`explorer-item-title text-[13px] font-display font-medium truncate pr-2 transition-colors flex items-center gap-1.5 min-w-0 ${
                selected ? "" : "text-ink-soft"
              }`}
              style={selected ? { color: accentColor } : undefined}
            >
              {badge ? (
                <span
                  className="explorer-item-badge shrink-0 px-1 py-px rounded text-[9px] font-mono leading-none"
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
              <span className="explorer-item-meta text-[10px] text-ink-ghost font-mono tabular-nums shrink-0">{meta}</span>
            ) : null}
          </div>

          {subtitle ? (
            <p
              className={`explorer-item-subtitle text-[11px] text-ink-ghost leading-relaxed group-hover:text-ink-faint transition-colors ${
                subtitleLines === 1 ? "truncate" : "line-clamp-2"
              }`}
            >
              {subtitle}
            </p>
          ) : null}

          {details && details.length > 0 ? (
            <div className="explorer-item-details flex items-center gap-2 mt-1">
              {details.map((detail, index) => (
                <Fragment key={index}>
                  {index > 0 ? <span className="text-[10px] text-ink-ghost/40">·</span> : null}
                  <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">{detail}</span>
                </Fragment>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
