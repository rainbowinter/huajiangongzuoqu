import { useEffect, useState } from "react";
import type { ViewToolbarItem, ViewToolbarOption } from "../features/workspace/fileTypes";
import { toolbarIconKey } from "../features/plugins/viewAssets";
import { useViewportPopupPosition, type PopupPosition } from "./popupPosition";

/**
 * 预览区顶上那排控件 —— **宿主渲染，插件只声明**（`view.toolbar`）。
 *
 * 与 Markdown 那排格式化按钮同一个位置、同一套样式：文件类型换了，顶上那排就换成
 * 这个格式自己的工具，而不是让每个插件在自己的沙箱帧里再造一套长得不一样的。
 *
 * 状态是**单向**的：点一下 → `onCommand(id, value)` 发给视图；视图回 `state` 决定
 * 各项显示什么。这里不自己记账 —— 否则「放大」点了之后显示的是宿主猜的比例，
 * 而真正画出来的比例在视图那边，两边一旦分歧就是越点越离谱。
 */

/** 视图报上来的工具栏状态。 */
export interface ViewToolbarState {
  /** 按 id 覆盖显示文本。按钮的 label 也能被覆盖（「单页 / 连续」靠它）。 */
  values: Record<string, string>;
  /** 点亮的开关 id。只对 `toggle: true` 的按钮生效。 */
  pressed: readonly string[];
}

interface PluginViewToolbarProps {
  items: readonly ViewToolbarItem[];
  state: ViewToolbarState;
  onCommand: (id: string, value?: string) => void;
  /**
   * 图标：键是 `toolbarIconKey(id, value?)`，值是**已经消毒过的内联 SVG 文本**。
   *
   * 没给、或某一项没有图标 —— 一律照旧只显示文字。图标是**加法**，不是这一排的前提。
   */
  icons?: ReadonlyMap<string, string>;
}

/** 与「插件工具栏按钮」完全一致的那几个类：同一排里不该有两种手感。 */
const BUTTON_BASE =
  "h-6 px-2 flex items-center justify-center rounded text-[11px] transition-all cursor-pointer";
const BUTTON_IDLE = "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50";
const BUTTON_ACTIVE = "text-bamboo bg-bamboo-mist/60";

/** 输入框：回车提交。用户没在打字时显示视图报的值，打字时显示他自己敲的。 */
function ToolbarInput({
  item,
  value,
  onCommand,
}: {
  item: Extract<ViewToolbarItem, { kind: "input" }>;
  value: string;
  onCommand: (id: string, value?: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft ?? value}
      placeholder={item.placeholder ?? ""}
      title={item.title ?? item.id}
      aria-label={item.title ?? item.id}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          const submitted = (draft ?? "").trim();
          setDraft(null);
          if (submitted) onCommand(item.id, submitted);
        } else if (event.key === "Escape") {
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
      className="h-6 rounded-md bg-paper-warm px-1.5 text-center text-[11px] text-ink-soft placeholder:text-ink-ghost/70 tabular-nums focus:outline-none focus:ring-1 focus:ring-bamboo/40"
      style={{ width: item.width ?? 52 }}
    />
  );
}

/** 只认 `#rrggbb`。给原生 `<input type="color">` 喂别的形状它当场报警告。 */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * 任意取色：自绘的色块 + 一个**完全透明**的原生 `<input type="color">` 盖在上面。
 *
 * 为什么不直接把 `<input type="color">` 当色块用：它在十几像素下撑不满 —— UA 内部那块
 * 色板有自己的最小尺寸与内边距，缩到这里只剩一条横线。自绘之后尺寸完全归我们管，
 * 只借它的「点开系统调色盘」这一个能力。（编辑器里那些行内色块用的是同一招。）
 *
 * 值走 `state.values[id]`，改完发 `{ id, value }` —— 与 `input` / `menu` 同一条命令通道，
 * 视图那边不必为它单开一种消息。
 */
function ToolbarColor({
  item,
  value,
  onCommand,
}: {
  item: Extract<ViewToolbarItem, { kind: "color" }>;
  value: string;
  onCommand: (id: string, value?: string) => void;
}) {
  const color = HEX_COLOR.test(value) ? value : "#ffd400";

  return (
    <label
      title={item.title ?? item.id}
      className={`view-toolbar-button relative w-6 h-6 flex items-center justify-center rounded transition-all cursor-pointer ${BUTTON_IDLE}`}
    >
      <span
        className="w-3.5 h-3.5 rounded-[3px] border border-paper-deep/70"
        style={{ background: color }}
      />
      <input
        type="color"
        value={color}
        aria-label={item.title ?? item.id}
        onChange={(event) => onCommand(item.id, event.target.value)}
        className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
      />
    </label>
  );
}

/**
 * 按钮 + 下拉。
 *
 * 下拉**贴在按钮下面**（`useViewportPopupPosition` 会把它夹回视口里），点一项就收起来 ——
 * 它是个选择器，不是浮层那种要连点好几下的面板。
 *
 * 当前选中项来自 `state.values[id]`：**按钮上显示的就是那一项的文字**，所以从外面看
 * 「现在用的是什么工具 / 什么颜色」一眼就知道，不必点开。
 */
function ToolbarMenu({
  item,
  value,
  icons,
  onCommand,
}: {
  item: Extract<ViewToolbarItem, { kind: "menu" }>;
  value: string;
  icons?: ReadonlyMap<string, string>;
  onCommand: (id: string, value?: string) => void;
}) {
  const [anchor, setAnchor] = useState<PopupPosition | null>(null);
  const { popupRef, popupPosition } = useViewportPopupPosition(anchor);

  useEffect(() => {
    if (!anchor) return;
    const close = (event: MouseEvent) => {
      // 点在下拉里交给各选项自己收；点别处（含触发按钮）一律关掉。
      if (!popupRef.current?.contains(event.target as Node)) setAnchor(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAnchor(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, popupRef]);

  const current = item.options.find((option) => option.value === value);
  const open = anchor !== null;

  return (
    <>
      <button
        type="button"
        title={item.title ?? item.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          if (open) {
            setAnchor(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
        className={`view-toolbar-button ${BUTTON_BASE} gap-1.5 ${open ? `is-active ${BUTTON_ACTIVE}` : BUTTON_IDLE}`}
      >
        {iconOf(icons, item.id, value) ? (
          <Icon svg={iconOf(icons, item.id, value)!} />
        ) : current?.color ? (
          <Swatch color={current.color} />
        ) : null}
        {current?.label ?? item.label}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="w-2.5 h-2.5 opacity-70"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {anchor ? (
        <div
          ref={popupRef}
          role="menu"
          aria-label={item.title ?? item.label}
          className="popup-menu fixed z-[9999] min-w-[132px] py-1 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg shadow-lg animate-menu-enter"
          style={{ left: popupPosition?.x ?? anchor.x, top: popupPosition?.y ?? anchor.y }}
          // 下拉里的点击不该冒到外面去（外面的监听会把它当成「点了别处」而关掉）。
          onMouseDown={(event) => event.stopPropagation()}
        >
          {item.options.map((option) => (
            <MenuOption
              key={option.value}
              option={option}
              icons={icons}
              menuId={item.id}
              selected={option.value === value}
              onPick={() => {
                onCommand(item.id, option.value);
                setAnchor(null);
              }}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * 取某一项（或某个选项）的图标。菜单的图标键带 `value`，按钮的不带 —— 用同一个
 * `toolbarIconKey` 算，两边不会对不上。
 */
function iconOf(
  icons: ReadonlyMap<string, string> | undefined,
  id: string,
  value?: string,
): string | undefined {
  return icons?.get(toolbarIconKey(id, value));
}

/**
 * 一个图标。
 *
 * ⚠️ `dangerouslySetInnerHTML` 在这里是**故意的**，而且安全的唯一理由是：
 * 传进来的 SVG 已经过 `sanitizeSvg`（只留形状标签与画图属性，`on*` / `<script>` /
 * `<foreignObject>` / `href` 全丢）。**别把没消毒的字符串喂给这个组件。**
 *
 * 尺寸写死在包裹元素上（`[&_svg]:w-3.5`）：插件给的 SVG 自己写多大都不算数 ——
 * 这一排的高度由宿主说了算，不然一个 200px 的图标能把工具栏顶开。
 */
function Icon({ svg }: { svg: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center w-3.5 h-3.5 shrink-0 [&_svg]:w-full [&_svg]:h-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="w-3 h-3 rounded-[3px] ring-1 ring-ink/15 shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

function MenuOption({
  option,
  icons,
  menuId,
  selected,
  onPick,
}: {
  option: ViewToolbarOption;
  icons?: ReadonlyMap<string, string>;
  menuId: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      title={option.title ?? option.label}
      onClick={onPick}
      className={`view-toolbar-button w-full flex items-center gap-2 px-2.5 h-7 text-left text-[11.5px] transition-colors cursor-pointer ${
        selected ? "is-active text-bamboo bg-bamboo-mist/50" : "text-ink-soft hover:bg-paper-warm"
      }`}
    >
      {iconOf(icons, menuId, option.value) ? (
        <Icon svg={iconOf(icons, menuId, option.value)!} />
      ) : option.color ? (
        <Swatch color={option.color} />
      ) : null}
      <span className="flex-1 truncate">{option.label}</span>
      {selected ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3 h-3 shrink-0"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
    </button>
  );
}

export function PluginViewToolbar({ items, state, onCommand, icons }: PluginViewToolbarProps) {
  if (items.length === 0) return null;

  return (
    <div className="view-toolbar flex items-center gap-0.5 px-4 pt-2 pb-1 shrink-0">
      {items.map((item, index) => {
        if (item.kind === "separator") {
          // 分隔线没有 id（`parseViewToolbar` 也不给它分配），key 只能靠位置。
          return <span key={`sep-${index}`} className="w-px h-3.5 mx-1.5 bg-paper-deep/60" />;
        }

        if (item.kind === "readout") {
          return (
            <span
              key={item.id}
              title={item.title ?? item.id}
              className="h-6 min-w-[40px] px-1.5 flex items-center justify-center text-[11px] text-ink-ghost font-mono tabular-nums"
            >
              {state.values[item.id] ?? ""}
            </span>
          );
        }

        if (item.kind === "input") {
          return (
            <ToolbarInput
              key={item.id}
              item={item}
              value={state.values[item.id] ?? ""}
              onCommand={onCommand}
            />
          );
        }

        if (item.kind === "color") {
          return (
            <ToolbarColor
              key={item.id}
              item={item}
              value={state.values[item.id] ?? ""}
              onCommand={onCommand}
            />
          );
        }

        if (item.kind === "menu") {
          return (
            <ToolbarMenu
              key={item.id}
              item={item}
              value={state.values[item.id] ?? ""}
              icons={icons}
              onCommand={onCommand}
            />
          );
        }

        const active = item.toggle === true && state.pressed.includes(item.id);
        return (
          <button
            key={item.id}
            type="button"
            title={item.title ?? item.label}
            aria-pressed={item.toggle ? active : undefined}
            // 编辑器那排按钮也这么做：按下鼠标不抢焦点，工具栏用起来才不打断输入。
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onCommand(item.id)}
            className={`view-toolbar-button ${BUTTON_BASE} gap-1.5 ${active ? `is-active ${BUTTON_ACTIVE}` : BUTTON_IDLE}`}
          >
            {iconOf(icons, item.id) ? <Icon svg={iconOf(icons, item.id)!} /> : null}
            {state.values[item.id] ?? item.label}
          </button>
        );
      })}
    </div>
  );
}
