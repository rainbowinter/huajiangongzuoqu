# 改界面样式：`src/styles/custom.css`

界面上的样式分散在两处：`src/App.css` 定义主题变量与语义类，其余绝大多数间距字号是直接
写在 JSX 上的 Tailwind 工具类。想在不动这些文件的前提下调整观感，改
**`src/styles/custom.css`** 就够了 —— 它是一份空壳，默认什么都不改。

文件开头有一份**目录**和一张**变量速查表**（22 个可改变量：名字 / 出厂值 / 管什么），
要改什么直接对着表抄即可。

## 它是怎么接进去的

`src/App.tsx` 里**紧跟在 `App.css` 之后**导入：

```ts
import "./App.css";
import "./styles/custom.css"; // ← 位置不能调换
```

构建后本文件排在 `App.css` 之后，于是同优先级的规则由它胜出。`App.css` 里那批
`.md-*` 预览规则用的也是同一招。

## 覆盖范围看选择器，不看「写在哪个文件」

这是最容易踩的一点。Tailwind 的 `@theme` 变量被编译进 `@layer theme`，而
分主题的覆盖块是**没有进任何 layer** 的：

| 想改的范围              | 选择器                                                        |
| ----------------------- | ------------------------------------------------------------- |
| 浅色 · 松绿（默认那套） | `:root`                                                       |
| 深色                    | `:root[data-theme="dark"]`                                    |
| 黛紫 / 樱粉（浅色）     | `:root[data-accent="purple"]` / `[data-accent="pink"]`        |
| 深色 + 某个主题色       | 两者组合，如 `:root[data-theme="dark"][data-accent="purple"]` |
| **上面全部**            | `custom.css` 第 2 节末尾那个组合选择器                        |

为什么 `:root` 盖不住深色/紫/粉：它们的 `:root[属性]` 选择器**权重高一档**
（`:root` 是 0-1-0，` :root[data-theme=…]` 是 0-2-0），权重高的先赢，跟谁写在后面无关。
组合选择器里每一段的权重都够，且本文件在后，所以能通吃。

字体与圆角（`--font-*`、`--app-*-radius`）**没有**分主题定义，写 `:root` 就是全主题生效。

## 稳定类名

想单独调某一块，用这些语义类，别去盖 Tailwind 工具类（工具类不是接口，改版就可能变）：

- 窗口外壳：`.app-window-shell` / `.app-main-frame` / `.app-surface-frame`
- 预览：`.md-body` / `.md-table` / `.md-divider` / `.md-quote` / `.md-caption`
- 提示框：`.markdown-alert` 及 `-note` `-tip` `-important` `-warning` `-caution`
- 其它：`.popup-menu`（菜单与浮层）、`.outline-item`、`.katex`、`.scrollbar-hidden`

工具类硬要盖也行，但得提权重（`.app-window-shell .px-4 { … }`）或上 `!important`。

## 另一条路：做成插件

改源码适合自己编译的场景。要让**装好的人**也能换主题，写成插件更合适 ——
`api.ui.registerStyle({ id, css })` 能把一段 CSS 注入当前窗口（需要 `ui:style` 权限），
样式是窗口粒度的，主窗口 / 小窗 / 磁贴各注入一份。参考
`example-plugins-v2/css-modifier/` 与 `Docs/plugin-api.md` 的 `api.ui` 一节。

两者不冲突：插件注入的样式同样排在后面，可以作为「用户在设置里可选的一套皮肤」。
