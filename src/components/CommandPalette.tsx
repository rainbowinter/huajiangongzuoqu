import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  formatKeybinding,
  listCommands,
  subscribeCommands,
  type CommandEntry,
} from "../features/commands/registry";
import { subscribeLoadedPlugins } from "../features/plugins/registry";

interface CommandPaletteProps {
  onClose: () => void;
}

/** 简单的子串匹配：命令数量是几十量级，不值得引入模糊匹配库。 */
function score(command: CommandEntry, query: string): number {
  if (!query) return 1;

  const title = command.title.toLowerCase();
  const source = command.source.toLowerCase();
  const needle = query.toLowerCase();

  if (title.startsWith(needle)) return 3;
  if (title.includes(needle)) return 2;
  if (source.includes(needle)) return 1;
  return 0;
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 插件加载/卸载会改变命令集合，订阅以保持列表新鲜。
  const commands = useSyncExternalStore(
    (listener) => {
      const unlistenCommands = subscribeCommands(listener);
      const unlistenPlugins = subscribeLoadedPlugins(listener);
      return () => {
        unlistenCommands();
        unlistenPlugins();
      };
    },
    listCommands,
    listCommands,
  );

  const results = useMemo(() => {
    return commands
      .map((command) => ({ command, rank: score(command, query) }))
      .filter((entry) => entry.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .map((entry) => entry.command);
  }, [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  const run = useCallback(
    (command: CommandEntry) => {
      onClose();
      void Promise.resolve()
        .then(() => command.run())
        .catch((error: unknown) => {
          console.error(`[commands] 执行命令 ${command.id} 失败`, error);
        });
    },
    [onClose],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current) =>
        results.length === 0 ? 0 : (current - 1 + results.length) % results.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const command = results[index];
      if (command) run(command);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9000] flex items-start justify-center pt-[12vh] bg-ink/10 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="command-palette w-[520px] max-h-[60vh] flex flex-col rounded-2xl bg-cloud/98 border border-paper-deep/40 shadow-xl overflow-hidden"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-paper-deep/30 shrink-0">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入命令名称…"
            className="command-palette-input w-full bg-transparent outline-none text-[13px] text-ink placeholder:text-ink-ghost"
          />
        </div>

        <div className="command-palette-list flex-1 min-h-0 overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="text-[12px] text-ink-ghost text-center py-6">
              {commands.length === 0 ? "暂无可用命令" : "没有匹配的命令"}
            </p>
          ) : (
            results.map((command, position) => (
              <button
                key={command.id}
                type="button"
                onMouseEnter={() => setIndex(position)}
                onClick={() => run(command)}
                className={`command-palette-item w-full px-4 py-2 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer ${
                  position === index ? "is-active bg-bamboo-mist/50" : "hover:bg-paper-warm"
                }`}
              >
                <span className="min-w-0">
                  <span className="block text-[12.5px] text-ink-soft truncate">
                    {command.title}
                  </span>
                  <span className="block text-[10px] text-ink-ghost truncate">
                    {command.source === "builtin" ? "内置" : `插件 ${command.source}`}
                  </span>
                </span>
                {command.keybinding ? (
                  <span className="text-[10px] text-ink-ghost font-mono shrink-0">
                    {formatKeybinding(command.keybinding)}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
