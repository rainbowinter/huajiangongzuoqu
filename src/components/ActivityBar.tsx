import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { POPUP_VIEWPORT_MARGIN, useViewportPopupPosition } from "./popupPosition";

/**
 * 最左侧的图标栏。
 *
 * 每一格对应一个「资源管理器视图」：第一格永远是应用自己的笔记，之后每添加一个工作
 * 文件夹就多一格，底部固定一个 `+` 用来添加。
 *
 * 栏本身**不塌陷**：侧栏面板可以收起，图标栏始终在位——否则收起之后就再也点不开了。
 */
export interface ActivityBarItem {
  id: string;
  title: string;
  icon: ReactNode;
  /**
   * 右键这一格时是否给出「从侧栏移除」。
   *
   * 笔记那一格是应用自带的视图，不是用户加进来的，移除对它没有意义 —— 所以默认不给，
   * 由调用方对工作文件夹显式打开。
   */
  removable?: boolean;
}

interface ActivityBarProps {
  items: ActivityBarItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  addTitle: string;
  /** 「从侧栏移除」的执行方；不传就完全不弹右键菜单。 */
  onRemove?: (id: string) => void;
}

interface BarMenu {
  id: string;
  x: number;
  y: number;
}

export function ActivityBar({
  items,
  activeId,
  onSelect,
  onAdd,
  addTitle,
  onRemove,
}: ActivityBarProps) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<BarMenu | null>(null);
  const { popupRef, popupPosition } = useViewportPopupPosition(menu);

  /**
   * 点别处 / 按 Esc 收起菜单。
   *
   * 用**捕获阶段** + 容器判定，而不是等它冒泡到 document：mousedown 比 click 早，
   * 冒泡阶段收到 mousedown 时按钮已经从树里摘掉了，click 再也发不出来。（另存为菜单
   * 踩过同一个坑。）
   */
  useEffect(() => {
    if (!menu) return;

    const closeOnOutside = (event: Event) => {
      if (popupRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    // 切走窗口时也要收：否则回来还挂着一个孤零零的菜单。
    const closeOnBlur = () => setMenu(null);

    document.addEventListener("mousedown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [menu, popupRef]);

  return (
    <div className="activity-bar w-11 shrink-0 flex flex-col items-center gap-1 pt-2 pb-2 bg-paper/40 border-r border-paper-deep/20">
      {items.map((item, index) => {
        const active = item.id === activeId;
        return (
          <Fragment key={item.id}>
            {/* 第 0 格永远是应用自己的笔记，第 1 格起是用户添加的工作文件夹。
                两者性质不同，中间加一条分隔线区分开。 */}
            {index === 1 ? <span className="w-5 h-px bg-paper-deep/60 my-1 shrink-0" /> : null}
            <button
              type="button"
              title={item.title}
              aria-label={item.title}
              aria-pressed={active}
              onClick={() => onSelect(item.id)}
              onContextMenu={(event) => {
                if (!onRemove || !item.removable) return;
                // 右键不切换视图：只弹菜单。顺手切过去会让「移除」这个词的宾语变得含糊
                // —— 到底是右键的那一格，还是现在已经跳过去的那一格？
                event.preventDefault();
                setMenu({ id: item.id, x: event.clientX, y: event.clientY });
              }}
              className={`activity-bar-item relative w-9 h-9 flex items-center justify-center rounded-lg transition-colors cursor-pointer ${
                active
                  ? "is-active text-bamboo bg-bamboo-mist/70"
                  : "text-ink-ghost hover:text-ink-soft hover:bg-paper-warm"
              }`}
            >
              {active ? (
                <span className="absolute left-[-6px] top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-bamboo/60" />
              ) : null}
              {item.icon}
            </button>
          </Fragment>
        );
      })}

      <button
        type="button"
        title={addTitle}
        aria-label={addTitle}
        onClick={onAdd}
        className="activity-bar-add mt-auto w-9 h-9 flex items-center justify-center rounded-lg text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/60 transition-colors cursor-pointer"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {menu ? (
        <div
          ref={popupRef}
          className="context-menu popup-menu fixed z-[9999] min-w-[168px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-x-hidden overflow-y-auto select-none animate-menu-enter"
          style={{
            left: popupPosition?.x ?? menu.x,
            top: popupPosition?.y ?? menu.y,
            maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
            maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              const target = menu.id;
              setMenu(null);
              onRemove?.(target);
            }}
            className="context-menu-item w-full flex items-center px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
          >
            {t("main.workspace.remove", { defaultValue: "从侧栏移除（不删除文件）" })}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 笔记视图的图标。 */
export function NotesIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

/** 工作文件夹的图标。 */
export function FolderIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
