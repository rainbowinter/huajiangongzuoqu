import { useEffect, useRef, useState } from "react";

interface FindReplacePanelProps {
  matchInfo: string;
  onFindNext: (findText: string) => void;
  onFindPrev: (findText: string) => void;
  onReplace: (findText: string, replaceText: string) => void;
  onReplaceAll: (findText: string, replaceText: string) => void;
  onClose: () => void;
}

export function FindReplacePanel({
  matchInfo,
  onFindNext,
  onFindPrev,
  onReplace,
  onReplaceAll,
  onClose,
}: FindReplacePanelProps) {
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    findInputRef.current?.focus();
  }, []);

  const handleFindKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      onFindNext(findText);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      onFindPrev(findText);
    }
  };

  return (
    <div className="fixed top-14 right-4 z-[9998] w-[340px] max-w-[92vw] rounded-xl border border-paper-deep/50 bg-cloud/95 backdrop-blur-sm shadow-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-medium text-ink">查找替换</span>
        <button
          type="button"
          onClick={onClose}
          className="w-5 h-5 flex items-center justify-center rounded text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <input
            ref={findInputRef}
            type="text"
            value={findText}
            onChange={(event) => setFindText(event.target.value)}
            onKeyDown={handleFindKeyDown}
            placeholder="查找内容"
            className="flex-1 min-w-0 px-2 py-1 text-[12px] rounded-lg border border-paper-deep/40 bg-paper/50 focus:border-bamboo/50 outline-none"
          />
          <span className="text-[10px] text-ink-ghost tabular-nums shrink-0">{matchInfo}</span>
          <button
            type="button"
            onClick={() => onFindPrev(findText)}
            className="w-6 h-6 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
            title="上一个"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 15l-6-6-6 6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onFindNext(findText)}
            className="w-6 h-6 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer"
            title="下一个"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={replaceText}
            onChange={(event) => setReplaceText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onReplace(findText, replaceText);
              }
            }}
            placeholder="替换为"
            className="flex-1 min-w-0 px-2 py-1 text-[12px] rounded-lg border border-paper-deep/40 bg-paper/50 focus:border-bamboo/50 outline-none"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onReplace(findText, replaceText)}
            className="px-2.5 py-1 text-[11px] text-ink-soft rounded-lg hover:bg-paper-warm transition-colors cursor-pointer"
          >
            替换
          </button>
          <button
            type="button"
            onClick={() => onReplaceAll(findText, replaceText)}
            className="px-2.5 py-1 text-[11px] text-bamboo rounded-lg hover:bg-bamboo-mist/50 transition-colors cursor-pointer"
          >
            全部替换
          </button>
        </div>
      </div>
    </div>
  );
}
