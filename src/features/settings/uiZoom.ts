/**
 * 整个界面的缩放（Ctrl + `=` / `-` / `0`）。
 *
 * 走的是 WebView 自己的缩放（`setZoom`）而不是 CSS：只有这样**图片、图标、边框**才
 * 会跟着一起放大，而且不会把布局撑坏。用 CSS transform 的话，虽然也能变大，但布局
 * 尺寸不变，滚动条和命中区域都会错位。
 *
 * 这一份是「整界面缩放」；预览区的纸张式放大是另一套（见 MainWindow 的 previewZoom）——
 * 两者互不干扰：前者改变 WebView 的缩放因子，后者只对预览内容做 transform。
 *
 * ⚠️ 需要 `core:webview:allow-set-webview-zoom` 权限（已加在 capabilities/default.json）。
 */

/** 缩放下限。再小的话中文会糊成一团。 */
export const UI_ZOOM_MIN = 0.6;

/** 缩放上限。 */
export const UI_ZOOM_MAX = 3;

/** 每一档的步长。 */
export const UI_ZOOM_STEP = 0.1;

const STORAGE_KEY = "floral-ui-zoom";

let current = 1;

function clamp(value: number): number {
  // 取整到 1% 是为了避免 0.1 累加出的浮点尾巴（0.30000000000000004）。
  const rounded = Math.round(value * 100) / 100;
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, rounded));
}

async function apply(scale: number): Promise<void> {
  current = scale;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(scale);
  } catch (error) {
    // 缩放只是显示偏好，失败不该影响别的功能。
    console.error("[zoom] 设置界面缩放失败", error);
  }
}

export function getUiZoom(): number {
  return current;
}

export function setUiZoom(scale: number): number {
  const next = clamp(scale);
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // 隐私模式 / 存储被禁用：缩放照常生效，只是不记住。
  }
  void apply(next);
  return next;
}

/** 启动时恢复上次的缩放。 */
export function restoreUiZoom(): number {
  let stored = 1;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) stored = parsed;
    }
  } catch {
    // 读不到就用 100%。
  }

  const next = clamp(stored);
  void apply(next);
  return next;
}

/**
 * 处理缩放快捷键。返回 `true` 表示这次按键已被处理（调用方应 `preventDefault`）。
 *
 * 认 `=` 与 `+` 两种写法：主键盘上直接按 Ctrl+= 是 `=`，按 Ctrl+Shift+= 才是 `+`，
 * 小键盘则直接给 `+`。三种都得管。
 */
export function handleUiZoomKey(event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;

  switch (event.key) {
    case "=":
    case "+":
      setUiZoom(current + UI_ZOOM_STEP);
      return true;
    case "-":
    case "_":
      setUiZoom(current - UI_ZOOM_STEP);
      return true;
    case "0":
      setUiZoom(1);
      return true;
    default:
      return false;
  }
}
