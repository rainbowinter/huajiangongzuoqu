import { useEffect, useState } from "react";
import type {
  PluginDocumentAction,
  PluginDocumentActionItem,
} from "../features/plugins/registry";
import { useViewportPopupPosition, type PopupPosition } from "./popupPosition";

/**
 * 主窗口顶上那一行里，**插件贡献的文档动作**（`ui.registerDocumentAction`）。
 *
 * 两种形态：
 *
 * - **一颗按钮** —— 点一下就做（`viewCommand` 转给当前那个沙箱视图，`run` 在插件 worker 里跑）；
 * - **一个下拉** —— 动作声明了 `items` 时用。同一件事的几种做法（导出原始 PDF / 导出带批注
 *   的 PDF）做成两颗并排的按钮更占地方，而且「导出」这个词会重复两遍。
 *
 * ## 图标两种写法
 *
 * `action.icon` 可能是**插件目录下的 `.svg` 路径**，也可能是一个**文字字形**。路径那种由
 * 调用方读好、消毒好再传进来（`icon` 这个 prop）—— 这一层只负责画，不碰磁盘。判据在
 * `viewAssets.ts` 的 `isIconAssetPath`。
 */

/** 与顶上那一行其它按钮同一套观感。 */
const BUTTON_CLASS =
  "doc-toolbar-button px-2.5 h-7 shrink-0 whitespace-nowrap flex items-center justify-center rounded-lg text-[11px] text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/40 transition-all cursor-pointer";

/**
 * 内联的图标。
 *
 * ⚠️ `dangerouslySetInnerHTML` 在这里是**故意的**，安全的唯一理由是：传进来的 SVG 已经过
 * `sanitizeSvg`（见 `loadPluginIcon`）。**别把没消毒的字符串喂给这个组件。**
 *
 * 尺寸写死在包裹元素上：插件给的 SVG 自己写多大都不算数，否则一个 200px 的图标能把这一行顶开。
 */
function Icon({ svg }: { svg: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center w-[13px] h-[13px] shrink-0 [&_svg]:w-full [&_svg]:h-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

interface DocumentActionButtonProps {
  action: PluginDocumentAction;
  /** 已消毒的内联 SVG（动作的 `icon` 写的是 `.svg` 路径时才有）。 */
  icon?: string;
  /** `item` 为空 = 点的是一颗普通动作按钮，不是下拉里的某一项。 */
  onRun: (item?: PluginDocumentActionItem) => void;
}

export function DocumentActionButton({ action, icon, onRun }: DocumentActionButtonProps) {
  const items = action.items ?? [];
  // 下拉那一支要 hook，普通按钮不要 —— 所以分开成两个组件，别在这里条件调用 hook。
  if (items.length > 0) {
    return <DocumentActionMenu action={action} icon={icon} items={items} onRun={onRun} />;
  }

  return (
    <button
      type="button"
      // 编辑器那排按钮也这么做：按下鼠标不抢焦点，点工具栏才不打断输入。
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onRun()}
      className={BUTTON_CLASS}
      title={`${action.title}（插件 ${action.plugin}）`}
    >
      {icon ? <Icon svg={icon} /> : (action.icon ?? action.title)}
    </button>
  );
}

/**
 * 下拉形态。
 *
 * 菜单**贴在按钮下面**，点一项就收起来 —— 它是个选择器，不是要连点好几下的面板。
 * 与 `view.toolbar` 的 `menu`、活动栏那个右键菜单是同一套（`useViewportPopupPosition`
 * 负责把它夹回视口里）。
 */
function DocumentActionMenu({
  action,
  icon,
  items,
  onRun,
}: {
  action: PluginDocumentAction;
  icon?: string;
  items: readonly PluginDocumentActionItem[];
  onRun: (item?: PluginDocumentActionItem) => void;
}) {
  const [anchor, setAnchor] = useState<PopupPosition | null>(null);
  const { popupRef, popupPosition } = useViewportPopupPosition(anchor);

  useEffect(() => {
    if (!anchor) return;

    // 用**捕获阶段**判「点在外面」：等它冒泡到 document 时，触发按钮可能已经从树里
    // 摘掉了，click 再也发不出来。（活动栏那个菜单踩过同一个坑。）
    const closeOnOutside = (event: MouseEvent) => {
      if (!popupRef.current?.contains(event.target as Node)) setAnchor(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAnchor(null);
    };
    // 切走窗口时也要收：否则回来还挂着一个孤零零的菜单。
    const closeOnBlur = () => setAnchor(null);

    document.addEventListener("mousedown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [anchor, popupRef]);

  const open = anchor !== null;

  return (
    <>
      <button
        type="button"
        title={`${action.title}（插件 ${action.plugin}）`}
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
        className={`${BUTTON_CLASS} gap-1 ${open ? "is-active text-bamboo bg-bamboo-mist/50" : ""}`}
      >
        {/* ⚠️ 下拉里**只画读好的 SVG**，文字字形一律不画：按钮上已经有 title 了，
            再摆一个字形多半和它一字不差（`icon: "导出"` + `title: "导出"`），看着像写重了。
            字形图标是**按钮没有文字时**的替代品 —— 那是上面那颗单按钮的场合。 */}
        {icon ? <Icon svg={icon} /> : null}
        <span>{action.title}</span>
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
          aria-label={action.title}
          className="popup-menu doc-action-menu fixed z-[9999] min-w-[150px] py-1 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg shadow-lg animate-menu-enter"
          style={{ left: popupPosition?.x ?? anchor.x, top: popupPosition?.y ?? anchor.y }}
          // 菜单里的点击不该冒到外面去（外面的监听会把它当成「点了别处」而关掉）。
          onMouseDown={(event) => event.stopPropagation()}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setAnchor(null);
                onRun(item);
              }}
              className="context-menu-item w-full flex items-center px-3 py-1.5 text-[11.5px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer whitespace-nowrap"
            >
              {item.title}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
