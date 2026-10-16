/**
 * 开关胶囊（只画外观，不含文字标签）。
 *
 * **交互留给调用方**：设置面板把它包在 `<label>` + 隐藏 checkbox 里（整行都可点），
 * 插件列表把它包在 `<button role="switch">` 里（要支持禁用态与加载中）。
 * 两处共用这一份外观，改一次两边都跟着变。
 */
export function Switch({ checked }: { checked: boolean }) {
  return (
    <div
      className={`switch relative w-8 h-[18px] rounded-full shrink-0 transition-colors duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        checked ? "is-on bg-bamboo" : "bg-paper-deep/50"
      }`}
    >
      <div
        className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.15)] transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          checked ? "translate-x-[14px]" : "translate-x-0"
        }`}
      />
    </div>
  );
}
