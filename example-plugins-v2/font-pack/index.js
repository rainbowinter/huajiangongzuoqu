/**
 * font-pack（v2）—— 把字体文件丢进文件夹就能用
 *
 * 用法：把 `.ttf` / `.otf` / `.woff2` 复制到本插件的 `fonts/` 目录，重载插件即可。
 * 它们会自动出现在「设置 → 代码字体」的「插件字体」分组里，并立刻可用于代码编辑器、
 * Markdown 代码块与行内代码。
 *
 * **这个插件不读任何文件，也拿不到任何路径。** 它只喊一句「我的字体在 fonts/ 里」：
 * 列目录、把文件变成 WebView 能加载的 URL、拼 `@font-face`、注入样式、登记族名，
 * 全部由宿主完成；回给插件的只有字体**名字**。
 *
 * 所以它不需要声明任何权限 —— 能力比 `ui.registerStyle`（要 `ui:style`）还弱：
 * 插件塞不进任意 CSS，规则是宿主按校验过的文件名生成的。
 */

/**
 * 族名 / 字重 / 字形默认从字体**内部**的 `name` 与 `OS/2` 表读出来（宿主在 Rust 侧
 * 拆开 sfnt 容器读的），文件名只是读不出来时的兜底。所以正常情况下这里不用写任何东西。
 *
 * ⚠️ 别指望文件名：`JetBrainsMono-Regular.ttf` 按驼峰拆是 "Jet Brains Mono"，而真名是
 * "JetBrains Mono"。真正装了字体文件时宿主会读到真名，这条兜底只在 WOFF 这类读不出内部
 * 名称的格式上生效。
 *
 * 只有「既读不出内部名称、文件名又实在看不出来」的字体才需要在这里兜一条，键是文件名：
 *
 *   "weird-1.ttf": { family: "正经族名", weight: 400, style: "normal" },
 */
const overrides = {};

floral.register({
  async onLoad(api) {
    const { families, count } = await api.fonts.register({ dir: "fonts", overrides });

    if (count === 0) {
      api.log.info("字体包：fonts/ 目录还是空的，把字体文件丢进去再重载一次即可。");
      return;
    }

    api.log.info(`字体包：加载了 ${count} 个字体文件，共 ${families.length} 个字体族 —— ${families.join("、")}`);
  },
});
