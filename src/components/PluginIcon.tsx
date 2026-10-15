import { useState } from "react";

/**
 * 插件图标。没给图标就用宿主的默认图标 —— **不提供图标是完全正常的**，
 * 不该让那一行看起来像坏了。
 *
 * `icon` 一定是 **data URL**：本地插件那边由 Rust 读文件做好（`manifest.rs` 的
 * `read_icon`），市场那边内联在已签名的清单里（`market/catalog.rs`）。两边同一个形状，
 * 所以这里只有一条渲染路径 —— 也顺带绕开了 asset 协议「要在渲染之前放行范围」的时序问题。
 */

/** 默认图标：四片花瓣（花笺自己的记号）。几笔就能画对，不依赖任何外部字体或图标库。 */
function DefaultPluginIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="7.6" r="3.9" />
      <circle cx="12" cy="16.4" r="3.9" />
      <circle cx="7.6" cy="12" r="3.9" />
      <circle cx="16.4" cy="12" r="3.9" />
    </svg>
  );
}

export function PluginIcon({
  icon,
  size = 16,
  className = "",
}: {
  /** data URL；缺省、空串、`undefined` 都用默认图标。 */
  icon?: string | null;
  size?: number;
  /** 默认图标的颜色走 `currentColor`，所以这里给文字色就行。 */
  className?: string;
}) {
  // data URL 不该加载失败，但真坏了要**退回默认图标**而不是留一个破图（或者一片空白）。
  const [broken, setBroken] = useState(false);

  if (!icon || broken) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center ${className}`}>
        <DefaultPluginIcon size={size} />
      </span>
    );
  }

  return (
    <img
      src={icon}
      // 图标是装饰，插件名就在旁边 —— 空 alt 让读屏软件跳过它，而不是念一串「图片」。
      alt=""
      width={size}
      height={size}
      className={`shrink-0 rounded-[4px] object-contain ${className}`}
      onError={() => setBroken(true)}
    />
  );
}
