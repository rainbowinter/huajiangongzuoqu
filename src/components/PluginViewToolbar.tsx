import { useState } from "react";
import type { ViewToolbarItem } from "../features/workspace/fileTypes";

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

export const EMPTY_TOOLBAR_STATE: ViewToolbarState = { values: {}, pressed: [] };

interface PluginViewToolbarProps {
  items: readonly ViewToolbarItem[];
  state: ViewToolbarState;
  onCommand: (id: string, value?: string) => void;
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

export function PluginViewToolbar({ items, state, onCommand }: PluginViewToolbarProps) {
  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 px-4 pt-2 pb-1 shrink-0">
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
            className={`${BUTTON_BASE} ${active ? BUTTON_ACTIVE : BUTTON_IDLE}`}
          >
            {state.values[item.id] ?? item.label}
          </button>
        );
      })}
    </div>
  );
}
