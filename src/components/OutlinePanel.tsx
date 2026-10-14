import type { OutlineItem } from "../features/markdown/outline";

interface OutlinePanelProps {
  items: OutlineItem[];
  onJump: (offset: number) => void;
  onClose: () => void;
}

export function OutlinePanel({ items, onJump, onClose }: OutlinePanelProps) {
  return (
    <aside className="w-[240px] h-full shrink-0 border-l border-paper-deep/30 bg-cloud/92 backdrop-blur-sm flex flex-col">
      <div className="px-4 pt-3 pb-2 flex items-center justify-between shrink-0">
        <span className="text-[13px] font-medium text-ink">目录</span>
        <button
          type="button"
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="px-3 pb-3 flex-1 min-h-0 overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-[12px] text-ink-ghost text-center py-8">暂无标题</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {items.map((item, index) => (
              <button
                key={index}
                type="button"
                onClick={() => onJump(item.offset)}
                className="text-left px-2 py-1 rounded-lg hover:bg-paper-warm transition-colors cursor-pointer"
                style={{ paddingLeft: `${8 + item.level * 12}px` }}
              >
                <span className="text-[12px] text-ink-soft truncate block">{item.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
