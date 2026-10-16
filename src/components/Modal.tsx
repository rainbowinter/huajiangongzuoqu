import type { ReactNode } from "react";

/**
 * 居中模态框。**确认框、提示框都用这一个**。
 *
 * 抽出来之前，市场面板与插件的提示框各写了一份一模一样的遮罩 + 卡片 —— 两份还能忍，
 * 但第三个（移除工作文件夹时问「要不要连缓存一起删」）再抄一遍，改观感时就一定会漏掉
 * 其中一个。
 *
 * 点遮罩即取消：这里承载的都是「还没发生任何事」的确认，关掉是安全的（反过来，如果哪天
 * 要在模态里做「已经写了一半」的操作，别用这一层，得自己挡掉遮罩点击）。
 */
export function Modal({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[9500] flex items-center justify-center bg-ink/20 backdrop-blur-[2px]"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-[400px] max-h-[70vh] overflow-y-auto rounded-2xl bg-cloud/98 border border-paper-deep/40 shadow-xl p-5"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <h3 className="text-[13px] text-ink mb-3">{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** 模态框底部那两颗按钮。取消在左、确认在右，是各处一致的手感。 */
export function ModalActions({
  busy,
  confirmLabel,
  onCancel,
  onConfirm,
  danger,
}: {
  busy: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** 破坏性动作（删东西）用红色 —— 让人在按下去之前多看一眼。 */
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-2 mt-4">
      <button
        type="button"
        disabled={busy}
        onClick={onCancel}
        className="px-3 h-7 rounded-lg text-[11px] text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer disabled:opacity-40"
      >
        取消
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        className={`px-3 h-7 rounded-lg text-[11px] transition-colors cursor-pointer disabled:opacity-40 ${
          danger
            ? "text-rust bg-rust-mist/50 hover:bg-rust-mist"
            : "text-bamboo bg-bamboo-mist/50 hover:bg-bamboo-mist"
        }`}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
