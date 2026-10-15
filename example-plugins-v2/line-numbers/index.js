/**
 * line-numbers（v2）—— 给编辑区左侧加一栏行号
 *
 * 这个插件只做一件事：把行号算出来。**排版一概不管** —— 换行位置、行高、滚动同步全部
 * 由宿主负责。
 *
 * 这不是偷懒，是接口划在哪儿的问题：插件跑在 worker 里，没有 DOM，量不到编辑器的字体、
 * 宽度和换行（同一行折成三行，行号该只出现一次）。所以 `ui.registerGutter` 的约定是
 * **插件出文字，宿主出排版**：
 *
 *   render() 返回一个字符串数组，第 i 项对应正文第 i 个逻辑行。
 *
 * 宿主会把每一行的原文按与编辑器完全相同的宽度再排一遍（不可见），于是行高天然对得上。
 * 空字符串表示「这一行没有标注」—— 对行号插件来说用不上，但对 git blame、TODO 标记
 * 这类旁注正是要的：它们本来就只有少数几行有内容。
 *
 * ---------------------------------------------------------------------------
 *
 * 栏宽是**可调参数**（见 plugin.json 的 contributes.settings），改设置之后要重新注册一遍
 * 才生效 —— 宿主对同一个 id 的重复注册是**替换**而不是叠加，所以这里可以放心地反复调用。
 */
floral.register({
  onLoad(api) {
    /** 与 plugin.json 里的 default 保持一致；设置还没读到时先用它。 */
    const DEFAULT_WIDTH = 36;

    /** 宿主允许的栏宽区间。设置是用户随手填的，填 0 或者 "abc" 不该把编辑区搞坏。 */
    const MIN_WIDTH = 20;
    const MAX_WIDTH = 120;

    let width = DEFAULT_WIDTH;

    /** 把设置里的值收敛成合法栏宽；真的变了才返回 true（免得白重注册一次）。 */
    const applyWidth = (value) => {
      const next = Number(value);
      if (!Number.isFinite(next)) return false;

      const clamped = Math.min(Math.max(Math.round(next), MIN_WIDTH), MAX_WIDTH);
      if (clamped === width) return false;

      width = clamped;
      return true;
    };

    const register = () => {
      api.ui.registerGutter({
        id: "line-numbers",
        title: "行号",
        width,

        render() {
          const content = api.editor.getContentSync();
          // 空文档也算一行 —— 否则刚打开的新笔记连个「1」都没有，看着像坏了。
          const count = content.split("\n").length;
          return Array.from({ length: count }, (_, index) => String(index + 1));
        },
      });
    };

    register();

    /**
     * 读一次初始值，拿到的是用户在插件面板里配过的值（没配过则是清单里的 default）。
     *
     * ⚠️ `settings.get()` **需要清单里声明 `settings` 权限**（见 Docs/plugin-api.md 的权限表），
     * 漏了会被权限门直接拒掉 —— 而且拒绝只写进插件日志，界面上的表现就是「设置改了不生效，
     * 得等下次 `settings.changed` 才恢复」，极难查。这里曾经就漏过。
     */
    void api.settings.get().then((values) => {
      if (applyWidth(values && values.width)) register();
    });

    // 用户在插件面板里改了栏宽 —— 同一个 id 重新注册就是替换，宿主据此重排。
    api.events.on("settings.changed", (values) => {
      if (applyWidth(values && values.width)) register();
    });
  },
});
