import { startDrag } from "@crabnebula/tauri-plugin-drag";

/**
 * 把工作区里的文件 / 文件夹**原生拖出**窗口（拖到资源管理器里就是复制 / 移动）。
 *
 * 为什么不能用 HTML5 拖拽：`dataTransfer` 到不了操作系统，浏览器最多把一个 `file://`
 * 地址当作文本丢出去。真正的「拖一个文件出去」必须走 Windows 的 `DoDragDrop`
 *（`tauri-plugin-drag` 在 Rust 侧做了这件事）。
 *
 * ⚠️ 调用方必须在 `dragstart` 里先 `preventDefault()`，否则 WebView2 自己的拖拽会和
 * 原生拖拽抢鼠标。插件在命令里把 `start_drag` 派发到主线程，那里会阻塞到用户松手，
 * 所以这里只需要 `void` 掉这个 Promise。
 */

let cachedIcon: string | null = null;

/**
 * 拖动时跟着鼠标的小图标。插件收 `data:image/png;base64,…`，于是这里现画一个
 * 24×24 的「纸张」图标，不用把二进制资源塞进仓库。
 */
function previewIcon(): string {
  if (cachedIcon) return cachedIcon;

  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 24;
  const context = canvas.getContext("2d");
  if (!context) {
    // 没有 canvas 就退化成一张 1×1 透明 PNG —— 拖拽本身仍然可用。
    cachedIcon =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    return cachedIcon;
  }

  context.clearRect(0, 0, 24, 24);
  context.fillStyle = "#f7f3ea";
  context.strokeStyle = "#8a9a7b";
  context.lineWidth = 1.5;

  // 圆角纸张
  context.beginPath();
  context.moveTo(6, 3);
  context.lineTo(15, 3);
  context.lineTo(19, 7);
  context.lineTo(19, 21);
  context.lineTo(6, 21);
  context.closePath();
  context.fill();
  context.stroke();

  // 折角
  context.beginPath();
  context.moveTo(15, 3);
  context.lineTo(15, 7);
  context.lineTo(19, 7);
  context.stroke();

  // 两条文字线
  context.strokeStyle = "#b9c2b0";
  context.beginPath();
  context.moveTo(9, 12);
  context.lineTo(16, 12);
  context.moveTo(9, 16);
  context.lineTo(14, 16);
  context.stroke();

  cachedIcon = canvas.toDataURL("image/png");
  return cachedIcon;
}

/** 开始一次原生文件拖拽。失败只记 debug 日志 —— 右键「复制」仍然可用。 */
export async function startFileDragOut(path: string): Promise<void> {
  try {
    await startDrag({ item: [path], icon: previewIcon() });
  } catch (error) {
    console.debug("[workspace] 拖出文件失败", error);
  }
}
