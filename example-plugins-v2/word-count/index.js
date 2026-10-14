/**
 * word-count（v2）
 *
 * 演示最小可用的 v2 插件：注册一个状态栏项，并在渲染时读插件自己的设置。
 *
 * 与 v1 版的差别：
 * - `floral.register` 不再传 `name`（宿主以下发下来的 `api.plugin` 为准）。
 * - 状态栏渲染函数可以是 async 的（`render` 在 Worker 里执行，返回值经 RPC 回来）。
 *   这里仍写成同步函数——沙箱会把它当作已 resolve 的 Promise 处理。
 */
floral.register({
  onLoad(api) {
    let countMode = "chars";

    // 设置是宿主下发的快照，读取无需往返。
    api.settings.get().then((values) => {
      if (typeof values.countMode === "string") countMode = values.countMode;
    });

    api.ui.registerStatusBarItem({
      id: "word-count.selection",
      render(selection) {
        if (!selection || !selection.text) return null;
        return format(selection.text, countMode);
      },
    });

    api.log.info("word-count 已加载");
  },

  onUnload() {
    // 宿主会自动释放本插件注册的状态栏项，这里只做插件自己的收尾。
  },
});

function format(text, mode) {
  switch (mode) {
    case "words": {
      const words = text.split(/\s+/).filter(Boolean).length;
      return `选中 ${words} 词`;
    }
    case "lines": {
      const lines = text.split(/\r?\n/).length;
      return `选中 ${lines} 行`;
    }
    default: {
      const chars = Array.from(text.replace(/\s/g, "")).length;
      return `选中 ${chars} 字`;
    }
  }
}
