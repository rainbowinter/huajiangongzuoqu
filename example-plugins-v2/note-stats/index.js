/**
 * note-stats（v2）
 *
 * 演示 v2 才有的两件东西：
 *
 * 1. **事件总线**。v1 插件收不到任何宿主变化，只能被动被调用。这里订阅
 *    `note:changed` / `editor:contentChanged` / `note:opened`，实时累计计数。
 *
 * 2. **插件级持久化**。`api.storage` 落在 `<笔记数据目录>/plugin-data/note-stats/`，
 *    与插件代码分开放，所以插件升级、甚至整个替换插件目录都不会丢数据。
 *
 * 多窗口语义提醒：插件运行时是**每窗口一份**，因此每个窗口各有一份内存计数与
 * 各自的订阅；但 `storage` 是共享的一只文件，同一刻从多个窗口写是「后写覆盖」。
 * 这个示例只在累计跨会话总数时写存储，因此不受影响。
 */
floral.register({
  onLoad(api) {
    let notifyOnSave = false;
    let sessionChanges = 0;
    let totalChanges = 0;

    api.settings.get().then((values) => {
      notifyOnSave = Boolean(values.notifyOnSave);
    });

    // 把上次会话的累计值读回来
    api.storage.get("totalChanges").then((value) => {
      totalChanges = Number(value) || 0;
    });

    api.events.on("editor:contentChanged", () => {
      sessionChanges += 1;
      totalChanges += 1;
      renderPanel();
    });

    api.events.on("note:opened", (payload) => {
      api.log.info(`打开了笔记 ${payload && payload.id}`);
      renderPanel();
    });

    api.events.on("note:changed", () => {
      if (notifyOnSave) api.ui.showToast("笔记已变化", "info");
    });

    api.ui.registerPanel({
      id: "note-stats",
      title: "统计",
      standalone: true,
      render() {
        return renderPanel();
      },
    });

    function renderPanel() {
      return (
        '<div style="padding:12px 4px;font-size:12px;line-height:1.9;">' +
        '<div style="display:flex;justify-content:space-between;">' +
        "<span>本次会话内容变化</span><b>" +
        sessionChanges +
        "</b></div>" +
        '<div style="display:flex;justify-content:space-between;">' +
        "<span>累计（跨会话）</span><b>" +
        totalChanges +
        "</b></div>" +
        "</div>"
      );
    }

    api.ui.registerToolbarButton({
      id: "note-stats.save",
      title: "保存统计",
      run: async () => {
        await api.storage.set("totalChanges", totalChanges);
        api.ui.showToast(`累计变化次数已保存：${totalChanges}`, "info");
      },
    });

    // 供 onUnload 使用：把累计值落盘。
    // 也可以每次变化都写，但那样太吵，这里选在卸载时统一写一次。
    persist = async () => {
      await api.storage.set("totalChanges", totalChanges);
    };
  },

  async onUnload() {
    // onUnload 里依然可以调用 api（宿主会等它 resolve，上限 5 秒）。
    // 注意：此时注册项已经在释放流程里，不要再注册新东西。
    await persist?.();
  },
});

/** onUnload 拿不到 onLoad 的局部变量，用一个模块级钩子接过来。 */
let persist = null;
