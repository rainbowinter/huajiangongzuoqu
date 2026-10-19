import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";

/**
 * 正文区自己的竖向滚动条。**编辑、分栏、预览共用这一条**，挂在内容区那一层，
 * 只是「跟着谁滚」按当前视图切换：
 *
 * - 编辑 / 分栏 → 透明的 `<textarea>`；
 * - 预览 → 预览的滚动层（`previewScrollRef`）。
 *
 * ## 为什么不用原生的
 *
 * 编辑区是**两层**：透明 `<textarea>` 负责输入与滚动，上面一层高亮 `div` 负责显示字形。
 * 两层宽度必须逐像素一致，否则换行位置不同、整篇字都会错位。原生滚动条要占掉 textarea
 * 十几像素（高亮层拿不到同样宽度），所以 `App.css` 把 textarea 的滚动条藏了。预览层与
 * 分栏预览同样用 `.scrollbar-hidden` 藏掉，统一交给这一条。
 *
 * ## 怎么画
 *
 * 轨道挂在容器的右内边距里（不压正文），位置完全由目标元素的
 * `scrollTop / scrollHeight / clientHeight` 推出来；拖动滑块直接写它的 `scrollTop`。
 * 它只是**视图**、不参与布局，所以不会反过来影响正文宽度。
 */
export function EditorScrollbar({
  target,
  content,
  revision,
}: {
  /** 当前视图里「真正的那个滚动元素」。 */
  target: RefObject<HTMLElement | null>;
  /** 正文。打字时行数会变，得重新量一次内容高度。 */
  content?: string;
  /** 其它会让内容高度变化的量（比如预览的缩放）。变了就重量一次。 */
  revision?: unknown;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ height: 0, viewport: 0, top: 0 });
  const [trackHeight, setTrackHeight] = useState(0);

  /** 量一次内容高 / 视口高 / 当前滚动位置。值没变就不触发重渲染。 */
  const measure = useCallback(() => {
    const element = target.current;
    if (!element) return;
    setMetrics((previous) =>
      previous.height === element.scrollHeight &&
      previous.viewport === element.clientHeight &&
      previous.top === element.scrollTop
        ? previous
        : {
            height: element.scrollHeight,
            viewport: element.clientHeight,
            top: element.scrollTop,
          },
    );
  }, [target]);

  // 跟着目标元素走：滚动实时更新，自身尺寸变化（窗口缩放）也更新。
  useEffect(() => {
    const element = target.current;
    if (!element) return;

    measure();
    element.addEventListener("scroll", measure, { passive: true });

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);

    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
    // `content` / `revision` 变了说明内容高度可能变了 —— 重新量一次。
  }, [target, measure, content, revision]);

  useLayoutEffect(() => {
    const element = trackRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const sync = () => setTrackHeight(element.clientHeight);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scrollable = metrics.height - metrics.viewport;
  // 没得滚就不显示（但轨道要一直挂着，不然量不到它自己的高度）。
  const visible = scrollable > 1 && trackHeight > 0;

  const thumbHeight = visible
    ? Math.max(28, (metrics.viewport / metrics.height) * trackHeight)
    : 0;
  const thumbTop = visible
    ? Math.min(
        trackHeight - thumbHeight,
        (metrics.top / scrollable) * (trackHeight - thumbHeight),
      )
    : 0;

  /** 按滑块移动的像素换算出该滚多少。 */
  const scrollByPixels = (startScroll: number, startY: number, currentY: number) => {
    const element = target.current;
    if (!element || trackHeight - thumbHeight <= 0) return;
    const ratio = scrollable / (trackHeight - thumbHeight);
    element.scrollTop = startScroll + (currentY - startY) * ratio;
  };

  const onThumbMouseDown = (event: ReactMouseEvent) => {
    const element = target.current;
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();

    const start = { y: event.clientY, scroll: element.scrollTop };
    const onMove = (move: MouseEvent) => scrollByPixels(start.scroll, start.y, move.clientY);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** 点轨道空白处：把滑块中心挪到点击位置，并接着拖。 */
  const onTrackMouseDown = (event: ReactMouseEvent) => {
    if (event.target !== trackRef.current) return;
    const element = target.current;
    const track = trackRef.current;
    if (!element || !track) return;
    event.preventDefault();

    const rect = track.getBoundingClientRect();
    const ratio = scrollable / (trackHeight - thumbHeight);
    element.scrollTop = Math.max(0, (event.clientY - rect.top - thumbHeight / 2) * ratio);

    const start = { y: event.clientY, scroll: element.scrollTop };
    const onMove = (move: MouseEvent) => scrollByPixels(start.scroll, start.y, move.clientY);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      ref={trackRef}
      // `z-10`：它是内容区的兄弟节点，得压在面板之上（否则被预览区盖住）。
      className="editor-scrollbar absolute right-1 top-1 bottom-2 w-1.5 z-10"
      onMouseDown={onTrackMouseDown}
    >
      {visible ? (
        <div
          onMouseDown={onThumbMouseDown}
          className="absolute left-0 w-full rounded-full bg-ink-ghost/45 hover:bg-ink-faint transition-colors cursor-pointer"
          style={{ height: thumbHeight, top: thumbTop }}
        />
      ) : null}
    </div>
  );
}
