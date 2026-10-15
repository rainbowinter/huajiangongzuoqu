/**
 * css-modifier（v2）—— 页面样式修改器
 *
 * 两种生效方式：
 *
 * 1. **全局**：`styles/` 目录下的每个 `.css` 都注入当前窗口。往目录里丢一份新样式表、
 *    在插件面板点「重新加载」即可，不需要改这个脚本。**在花笺里改完保存会立刻生效**
 *    （宿主推 `plugin:assetsChanged` 过来，见下面的订阅），不用再点按钮。
 * 2. **单篇笔记**：笔记开头的 front-matter 写 `css: <名字>`，则把 `styles/<名字>.css`
 *    注入当前窗口。字段名可在插件设置里改（默认 `css`）。
 *
 * 这里用到的两个能力是本次改造才加进插件系统的，老版本插件 API 没有：
 * - `api.plugin.listAssets(dir)` / `api.plugin.readAsset(path)`
 *   读插件**自己目录**下的文本资源。不需要权限——插件代码本来就是从那个目录加载的。
 * - `api.ui.registerStyle({ id, css })`
 *   把一段 CSS 注入宿主页面，需要 `ui:style` 权限。返回的注册 id 可以交给
 *   `api.ui.dispose(id)` 单独撤销；插件卸载时宿主也会自动清理。
 *
 * 样式是**窗口粒度**的：主窗口、小窗、磁贴各有一份运行时，各自注入。
 */
floral.register({
  onLoad(api) {
    const STYLE_DIR = "styles";

    let noteStyleKey = "css";
    let injectGlobals = true;

    /** 已注入的全局样式表：文件名 → 注册 id。 */
    const globals = new Map();
    /** 上一次处理的 front-matter 取值（**含失败的情况**，避免每次按键都重试）。 */
    let noteStyleName = null;
    let noteStyleId = null;

    function message(error) {
      return error && error.message ? error.message : String(error);
    }

    function escapeHtml(text) {
      return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    /**
     * 从笔记开头的 front-matter 里读一个字段。
     *
     * 刻意写得比 YAML 宽松：只认 `key: value` 这种平铺写法，不支持嵌套与列表。
     * 这里只需要取一个样式表名字，引入完整 YAML 解析不划算。
     */
    function frontMatterValue(content, key) {
      if (!content || !content.startsWith("---")) return null;

      const headerEnd = content.indexOf("\n---", 3);
      if (headerEnd === -1) return null;

      const block = content.slice(content.indexOf("\n") + 1, headerEnd);
      for (const line of block.split("\n")) {
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
        if (!match) continue;
        if (match[1].toLowerCase() !== key.toLowerCase()) continue;
        return match[2].trim().replace(/^["']|["']$/g, "");
      }
      return null;
    }

    function normalizeFileName(name) {
      return name.toLowerCase().endsWith(".css") ? name : `${name}.css`;
    }

    /** 重新注入全部全局样式表。先撤旧的，保证改完文件不会留下上一版。 */
    async function applyGlobals() {
      for (const id of globals.values()) api.ui.dispose(id);
      globals.clear();

      if (!injectGlobals) return;

      let files = [];
      try {
        files = await api.plugin.listAssets(STYLE_DIR);
      } catch (error) {
        api.log.warn(`读取 ${STYLE_DIR}/ 失败：${message(error)}`);
        return;
      }

      for (const file of files) {
        if (!file.toLowerCase().endsWith(".css")) continue;
        try {
          const css = await api.plugin.readAsset(`${STYLE_DIR}/${file}`);
          globals.set(file, await api.ui.registerStyle({ id: file, css }));
        } catch (error) {
          api.log.error(`注入 ${file} 失败：${message(error)}`);
        }
      }
    }

    /** 让当前窗口的附加样式与笔记 front-matter 保持一致。 */
    async function applyNoteStyle() {
      const name = frontMatterValue(api.editor.getContentSync(), noteStyleKey);

      // 取值没变就什么都不做——这个函数挂在内容变化事件上，逐键重注入会很难看。
      if (name === noteStyleName) return;
      noteStyleName = name;

      if (noteStyleId) {
        api.ui.dispose(noteStyleId);
        noteStyleId = null;
      }
      if (!name) {
        render();
        return;
      }

      const file = normalizeFileName(name);
      try {
        const css = await api.plugin.readAsset(`${STYLE_DIR}/${file}`);
        noteStyleId = await api.ui.registerStyle({ id: `note:${file}`, css });
      } catch {
        api.log.warn(`笔记指定的样式表不存在：${STYLE_DIR}/${file}`);
      }
      render();
    }

    async function reload() {
      await applyGlobals();
      await applyNoteStyle();
      render();
    }

    function render() {
      const files = [...globals.keys()];

      const globalBody = !injectGlobals
        ? '<p class="cm-empty">全局注入已在设置里关闭。</p>'
        : files.length
          ? `<ul class="cm-list">${files
              .map((file) => `<li class="cm-item">${escapeHtml(file)}</li>`)
              .join("")}</ul>`
          : `<p class="cm-empty">${STYLE_DIR}/ 里还没有样式表。把 .css 放进去后点下面的按钮。</p>`;

      const noteBody = noteStyleId
        ? `<p class="cm-note">当前笔记附加：<b>${escapeHtml(noteStyleName)}</b></p>`
        : `<p class="cm-empty">当前笔记没有附加样式。在笔记开头写 <code>${escapeHtml(
            noteStyleKey,
          )}: 样式表名</code> 即可。</p>`;

      return (
        '<div style="padding:12px 4px;font-size:12px;line-height:1.9;">' +
        '<div style="font-weight:600;margin-bottom:4px;">全局样式表</div>' +
        globalBody +
        '<div style="font-weight:600;margin:14px 0 4px;">单篇笔记</div>' +
        noteBody +
        '<button class="cm-reload" style="margin-top:16px;width:100%;height:30px;border:1px solid var(--color-paper-deep);border-radius:8px;background:transparent;color:var(--color-ink-soft);font-size:12px;cursor:pointer;">重新加载</button>' +
        '<p class="cm-empty" style="margin-top:10px;">在花笺里改完 ' +
        STYLE_DIR +
        "/*.css 保存即生效；用外部编辑器改的，回来点上面的按钮。文件位置：插件面板 → 打开插件文件夹 → css-modifier/" +
        STYLE_DIR +
        "/</p>" +
        "</div>"
      );
    }

    api.settings.get().then((values) => {
      if (typeof values.noteStyleKey === "string" && values.noteStyleKey.trim()) {
        noteStyleKey = values.noteStyleKey.trim();
      }
      injectGlobals = values.injectGlobals !== false;
      return reload();
    });

    /**
     * 宿主在「保存了某个插件自己目录里的文件」时推过来 —— 也就是你在花笺里改完
     * `styles/*.css` 保存的那一刻。比对自己的名字过滤一下，然后重读一遍即可。
     *
     * ⚠️ 只有**在花笺里保存**才会触发。用外部编辑器改文件不会（那要文件监视器）。
     */
    let pluginName = null;
    void api.plugin.info().then((info) => {
      pluginName = info && info.name;
    });

    api.events.on("plugin:assetsChanged", (payload) => {
      if (!payload || payload.plugin !== pluginName) return;
      if (
        !String(payload.path || "")
          .toLowerCase()
          .endsWith(".css")
      )
        return;
      void reload();
    });

    // 内容变化是 150ms 尾节流的，不会每一次按键都打过来。
    api.events.on("editor:contentChanged", () => void applyNoteStyle());
    api.events.on("note:opened", () => void applyNoteStyle());

    api.ui.registerPanel({
      id: "css-modifier",
      title: "样式",
      standalone: true,
      width: 300,
      render,
      onClick(ref) {
        if (ref.closestClass("cm-reload")) void reload();
      },
    });

    api.ui.registerCommand({
      id: "css-modifier.reload",
      title: "重新加载样式表",
      run: async () => {
        await reload();
        api.ui.showToast(`已加载 ${globals.size} 份全局样式表`, "info");
      },
    });
  },

  onUnload() {
    // 注册项（含注入的 <style>）由宿主统一释放，这里不需要手动收尾。
  },
});
