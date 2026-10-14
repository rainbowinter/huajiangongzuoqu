import { useEffect, useRef, useState } from "react";
import { setPluginPromptProvider } from "../features/plugins/hosts/v2Host";

interface PendingPrompt {
  message: string;
  title?: string;
  defaultValue: string;
  placeholder?: string;
  resolve: (value: string | null) => void;
}

/**
 * 插件 `system.dialog.prompt` 的实现。
 *
 * 为什么不用原生对话框：Tauri 的 dialog 插件只提供 message / ask / confirm / open /
 * save，**没有 prompt**，`capabilities/default.json` 里也没有 `dialog:allow-ask`。
 * 与其为此放宽 ACL，不如自己渲染一个模态——样式还能和应用一致。
 *
 * 挂在 App 根上，通过 `setPluginPromptProvider` 把自己注册进 v2 宿主。
 */
export function PluginPromptDialog() {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPluginPromptProvider(
      (message, options) =>
        new Promise<string | null>((resolve) => {
          setValue(typeof options?.defaultValue === "string" ? options.defaultValue : "");
          setPending({
            message,
            ...(typeof options?.title === "string" ? { title: options.title } : {}),
            defaultValue: typeof options?.defaultValue === "string" ? options.defaultValue : "",
            ...(typeof options?.placeholder === "string"
              ? { placeholder: options.placeholder }
              : {}),
            resolve,
          });
        }),
    );

    return () => setPluginPromptProvider(null);
  }, []);

  useEffect(() => {
    if (pending) inputRef.current?.focus();
  }, [pending]);

  if (!pending) return null;

  const settle = (result: string | null) => {
    pending.resolve(result);
    setPending(null);
  };

  return (
    <div className="fixed inset-0 z-[9500] flex items-center justify-center bg-ink/20 backdrop-blur-[2px]">
      <div className="w-[380px] rounded-2xl bg-cloud/98 border border-paper-deep/40 shadow-xl p-5">
        {pending.title ? (
          <p className="text-[13px] font-medium text-ink mb-2">{pending.title}</p>
        ) : null}
        <p className="text-[12.5px] text-ink-soft whitespace-pre-wrap break-words">
          {pending.message}
        </p>

        <input
          ref={inputRef}
          value={value}
          placeholder={pending.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              settle(value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              settle(null);
            }
          }}
          className="w-full mt-3 px-3 py-2 text-[12.5px] rounded-lg bg-paper-warm/60 border border-paper-deep/30 outline-none text-ink-soft"
        />

        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={() => settle(null)}
            className="px-3 py-1.5 text-[12px] rounded-lg text-ink-ghost hover:bg-paper-warm transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => settle(value)}
            className="px-3 py-1.5 text-[12px] rounded-lg text-bamboo bg-bamboo-mist/50 hover:bg-bamboo-mist transition-colors cursor-pointer"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
