import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface SlidingButtonGroupProps<T extends string> {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  buttonClassName?: string;
}

export function SlidingButtonGroup<T extends string>({
  options,
  value,
  onChange,
  className = "",
  buttonClassName = "h-7",
}: SlidingButtonGroupProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [animated, setAnimated] = useState(false);
  /**
   * 这次定位是不是「切换选项」引起的。
   *
   * 布局变化引起的重算必须把过渡关掉：打开插件面板时侧栏会从 0 连续过渡到 360px，
   * 主列被一路压缩，若这时滑块还带着 0.25s 缓动去追按钮，它会始终落后于按钮，
   * 表现为「白块跑到别处」。关掉过渡后它逐帧贴着按钮走。
   */
  const [layoutStable, setLayoutStable] = useState(true);

  // 用 ref 读最新的 value，让 measure 保持稳定引用，ResizeObserver 才能只安装一次。
  const valueRef = useRef(value);
  valueRef.current = value;

  const measure = useCallback((fromLayout: boolean) => {
    const btn = buttonsRef.current.get(valueRef.current);
    if (!btn) return;
    setLayoutStable(!fromLayout);
    setPos({
      left: btn.offsetLeft,
      top: btn.offsetTop,
      width: btn.offsetWidth,
      height: btn.offsetHeight,
    });
  }, []);

  // 切换选项后重新测量，这一次保留滑动动画。
  useLayoutEffect(() => {
    measure(false);
  }, [value, measure]);

  /**
   * 容器尺寸变化时也要重测。
   *
   * 此前只在 `value` 变化时测量一次，组件内没有任何尺寸监听。于是打开「目录 / 统计」
   * 这类插件面板、拖拽侧栏宽度、或缩放窗口之后，按钮的 offset/宽度全变了而滑块还停在
   * 旧几何上——窗口越窄（竖屏）按钮被挤得越厉害，偏移越明显。
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => measure(true));
    observer.observe(container);
    for (const button of buttonsRef.current.values()) observer.observe(button);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    requestAnimationFrame(() => setAnimated(true));
  }, []);

  const transition =
    animated && layoutStable
      ? "left 0.25s cubic-bezier(0.22,1,0.36,1), top 0.25s cubic-bezier(0.22,1,0.36,1), width 0.25s cubic-bezier(0.22,1,0.36,1), height 0.25s cubic-bezier(0.22,1,0.36,1)"
      : "none";

  return (
    <div
      ref={containerRef}
      className={`segmented relative flex items-center gap-1 bg-paper-warm/60 rounded-lg p-[2px] border border-paper-deep/30 ${className}`}
    >
      <div
        className="absolute rounded-md bg-cloud shadow-[0_1px_2px_rgba(0,0,0,0.04)] pointer-events-none sliding-highlight"
        style={{ left: pos.left, top: pos.top, width: pos.width, height: pos.height, transition }}
      />
      {options.map((option) => (
        <button
          key={option.value}
          ref={(el) => {
            if (el) buttonsRef.current.set(option.value, el);
            else buttonsRef.current.delete(option.value);
          }}
          type="button"
          onClick={() => onChange(option.value)}
          className={`segmented-option relative z-[1] flex-1 rounded-md text-[11px] transition-colors duration-200 cursor-pointer ${buttonClassName} ${
            value === option.value
              ? "is-active text-bamboo font-medium"
              : "text-ink-ghost hover:text-ink-faint"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
