/**
 * css-modifier（v2）—— 单篇笔记的附加样式
 *
 * 笔记开头的 front-matter 写 `css: <名字>`，就把 `styles/<名字>.css` 注入当前窗口。
 * 字段名可在插件设置里改（默认 `css`）。
 *
 * ## ⚠️ 全局样式已经不归这个插件管了
 *
 * 以前这里还有一半功能：把 `styles/` 下的每份 `.css` 都当**全局样式**注入，并用一个
 * 「注入全局样式表」总开关统管。那半截**已经删掉**，改由宿主接管：
 *
 *   `<数据目录>/styles/*.css` —— 每一份都注入每个窗口，**没有开关**，
 *   改完保存约两秒后自动生效（宿主在轮询）。
 *
 * 用户入口：**设置 → 外观 → 界面样式**，或标题栏的「样式」按钮。
 *
 * 为什么挪走：那是「整个界面长什么样」的事，属于宿主而不是某个插件；而且两套
 * 「往文件夹里丢 CSS」的机制并存时，用户永远分不清该丢哪一个。现在边界很清楚 ——
 * **全局归宿主，单篇归这个插件**。
 *
 * 这里用到的两个能力：
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

    /**
     * 让当前窗口的附加样式与笔记 front-matter 保持一致。
     *
     * `force` 用于「文件被改过」的情况：取值没变，但那份 `.css` 的内容变了，
     * 得把上一次的注册撤掉重新读一遍。
     */
    async function applyNoteStyle(force = false) {
      const name = frontMatterValue(api.editor.getContentSync(), noteStyleKey);

      // 取值没变就什么都不做——这个函数挂在内容变化事件上，逐键重注入会很难看。
      if (!force && name === noteStyleName) return;
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
      // 强制重读：用户点这个按钮通常就是因为「改完文件了」。
      await applyNoteStyle(true);
      render();
    }

    function render() {
      const noteBody = noteStyleId
        ? `<p class="cm-note">当前笔记附加：<b>${escapeHtml(noteStyleName)}</b></p>`
        : `<p class="cm-empty">当前笔记没有附加样式。在笔记开头写 <code>${escapeHtml(
            noteStyleKey,
          )}: 样式表名</code> 即可。</p>`;

      return (
        '<div style="padding:12px 4px;font-size:12px;line-height:1.9;">' +
        '<div style="font-weight:600;margin-bottom:4px;">单篇笔记附加样式</div>' +
        noteBody +
        '<button class="cm-reload" style="margin-top:16px;width:100%;height:30px;border:1px solid var(--color-paper-deep);border-radius:8px;background:transparent;color:var(--color-ink-soft);font-size:12px;cursor:pointer;">重新读取</button>' +
        '<div style="font-weight:600;margin:18px 0 4px;">全局样式表</div>' +
        '<p class="cm-empty" style="margin:0;">全局样式**不在这里**。它们放在数据目录下的 ' +
        "<code>" +
        STYLE_DIR +
        "/</code>（整个界面共用，没有开关，改完约两秒自动生效）。入口：<b>设置 → 外观 → 界面样式</b>，或标题栏的「样式」按钮。</p>" +
        '<p class="cm-empty" style="margin-top:10px;">本插件只管**单篇笔记**：把 .css 放进插件目录的 ' +
        STYLE_DIR +
        "/，再在笔记开头写 <code>" +
        escapeHtml(noteStyleKey) +
        ": 文件名</code>。文件位置：插件面板 → 打开插件文件夹 → css-modifier/" +
        STYLE_DIR +
        "/</p>" +
        "</div>"
      );
    }

    api.settings.get().then((values) => {
      if (typeof values.noteStyleKey === "string" && values.noteStyleKey.trim()) {
        noteStyleKey = values.noteStyleKey.trim();
      }
      return applyNoteStyle();
    });

    /**
     * 宿主在「保存了某个插件自己目录里的文件」时推过来 —— 也就是你在花笺里改完
     * `styles/*.css` 保存的那一刻。比对自己的名字过滤一下，然后重读一遍即可。
     *
     * ⚠️ 只有**在花笺里保存**才会触发。用外部编辑器改文件不会（那要文件监视器）——
     * 那种情况请点上面的「重新读取」。
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
      void applyNoteStyle(true);
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
      title: "重新读取笔记附加样式",
      run: async () => {
        await reload();
        api.ui.showToast(
          noteStyleId ? `已套用 ${noteStyleName}` : "当前笔记没有附加样式",
          "info",
        );
      },
    });
  },

  onUnload() {
    // 注册项（含注入的 <style>）由宿主统一释放，这里不需要手动收尾。
  },
});
