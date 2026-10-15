import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { stackForPluginFamily } from "../features/fonts/fontFace";
import { listPluginFonts, subscribePluginFonts } from "../features/fonts/pluginFonts";
import {
  getCodeFont,
  matchCodeFontPreset,
  MONO_FALLBACK_TAIL,
  previewCodeFontStack,
  setCodeFont,
  visibleCodeFontPresets,
} from "../features/settings/codeFont";

/** 下拉里「自定义」那一项的 id。预设用各自的 id，插件字体带 `plugin:` 前缀，不会撞上。 */
const CUSTOM_ID = "__custom__";
const PLUGIN_PREFIX = "plugin:";

/**
 * 样张。
 *
 * 特意混了三类字符：数字与运算符（看等宽）、`0O` / `1lI`（看易混字形有没有区分）、
 * 汉字（看中文兜底有没有生效 —— 掉成方框或者突然变粗就是没兜上）。
 */
const SAMPLE = "const total = 0; // 汉字 0O1lI {}[] ≤ ≥";

/**
 * 插件字体的字体栈。
 *
 * ⚠️ 尾部**必须**接等宽兜底：插件一被停用，它注入的 `@font-face` 就跟着撤掉，那时栈里
 * 只剩这一段。直接接中文字体的话，代码会从等宽悄悄变成比例字形。
 */
function pluginStack(family: string): string {
  return stackForPluginFamily(family, MONO_FALLBACK_TAIL);
}

/**
 * 「代码字体」设置区。
 *
 * 状态有三份，别把它们搅在一起：
 *
 * * `codeFont` —— 真正生效的字体栈（空串 = 跟随系统）；
 * * `custom` —— 自定义输入框里的文本；
 * * `manual` —— 下拉是不是停在「自定义」上。
 *
 * 拆开是因为「切到自定义」不该立刻改字体：那时输入框还是空的，一路写下去会先把字体
 * 清成默认，下拉又跳回「跟随系统」，看着像点了个没反应的按钮。
 */
export function CodeFontSection() {
  const { t } = useTranslation();

  // 插件字体是异步来的（插件加载完才登记），所以必须订阅而不是只在挂载时读一次。
  // 快照是稳定引用，见 `pluginFonts.ts` 的说明 —— 否则这里会无限重渲染。
  const pluginFonts = useSyncExternalStore(subscribePluginFonts, listPluginFonts);

  // 初值只读一次 localStorage，三份状态同源，免得各读各的读出不一样。
  const [saved] = useState(getCodeFont);
  const [codeFont, setCodeFontState] = useState(saved);
  const [custom, setCustom] = useState(() => (matchCodeFontPreset(saved) ? "" : saved));
  const [manual, setManual] = useState(() => matchCodeFontPreset(saved) === null);

  // 两个插件提供同名字体是可能的，去重后当选项用，也避免 option 的 value 撞车。
  const pluginFamilies = [...new Set(pluginFonts.map((item) => item.family))];

  // 插件已经提供了的字体，从预设里拿掉 —— 否则同一个名字会出现两次。规则与那条
  // 「选中的例外」在 `visibleCodeFontPresets` 里，有单测钉着。
  const visiblePresets = visibleCodeFontPresets(codeFont, pluginFamilies);

  const activePreset = visiblePresets.find((preset) => preset.stack === codeFont) ?? null;
  const activePluginFamily =
    pluginFamilies.find((family) => pluginStack(family) === codeFont) ?? null;

  const selectedId = manual
    ? CUSTOM_ID
    : activePluginFamily
      ? `${PLUGIN_PREFIX}${activePluginFamily}`
      : (activePreset?.id ?? "system");

  const change = (stack: string) => {
    setCodeFontState(stack);
    setCodeFont(stack);
  };

  const handleSelect = (id: string) => {
    if (id === CUSTOM_ID) {
      // 用当前生效的栈打底，比从空白开始顺手；没选过就是空的，输入框会显示占位符。
      setCustom(codeFont);
      setManual(true);
      return;
    }

    setManual(false);

    if (id.startsWith(PLUGIN_PREFIX)) {
      change(pluginStack(id.slice(PLUGIN_PREFIX.length)));
      return;
    }

    change(visiblePresets.find((preset) => preset.id === id)?.stack ?? "");
  };

  const handleCustom = (value: string) => {
    setCustom(value);
    change(value);
  };

  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-body text-ink-faint">
        {t("settings.codeFont.title", { defaultValue: "代码字体" })}
      </h3>
      <p className="text-[10px] leading-relaxed text-ink-ghost/75">
        {t("settings.codeFont.hint", {
          defaultValue:
            "用于代码编辑器、Markdown 代码块与行内代码。列表之外的本机字体可以填在「自定义」里。",
        })}
      </p>

      <div className="relative">
        <select
          value={selectedId}
          onChange={(event) => handleSelect(event.target.value)}
          className="w-full h-8 pl-2.5 pr-7 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[12px] text-ink-soft outline-none appearance-none cursor-pointer"
        >
          {visiblePresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          {pluginFamilies.length > 0 && (
            <optgroup label={t("settings.codeFont.plugins", { defaultValue: "插件字体" })}>
              {pluginFamilies.map((family) => (
                <option key={family} value={`${PLUGIN_PREFIX}${family}`}>
                  {family}
                </option>
              ))}
            </optgroup>
          )}
          <option value={CUSTOM_ID}>
            {t("settings.codeFont.custom", { defaultValue: "自定义…" })}
          </option>
        </select>
        <svg
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-ghost"
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 3.5L5 6.5L8 3.5" />
        </svg>
      </div>

      {manual && (
        <input
          type="text"
          value={custom}
          onChange={(event) => handleCustom(event.target.value)}
          spellCheck={false}
          placeholder='"Foo Mono", Consolas, monospace'
          className="w-full h-8 px-2.5 rounded-lg bg-paper-warm/70 border border-paper-deep/40 text-[12px] font-mono text-ink-soft outline-none"
        />
      )}

      {/* 预览走内联样式而不是 font-mono 类：要显示的是**即将生效**的那条栈，
          「跟随系统」时它和当前默认栈可能并不相同。 */}
      <div
        style={{ fontFamily: previewCodeFontStack(codeFont) }}
        className="rounded-lg border border-paper-deep/30 bg-paper-warm/45 px-2.5 py-2 text-[12px] leading-[1.6] text-ink-soft truncate"
      >
        {SAMPLE}
      </div>

      {pluginFamilies.length === 0 && (
        <p className="text-[10px] leading-relaxed text-ink-ghost/60">
          {t("settings.codeFont.noPlugins", {
            defaultValue: "装上自带字体的插件后，它们也会出现在这个列表里。",
          })}
        </p>
      )}
    </section>
  );
}
