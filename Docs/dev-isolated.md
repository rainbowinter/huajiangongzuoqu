# 隔离调试

当机器上已经装了正式版花笺（例如 `C:\Program Files\floral-notepaper_1.0.7`）并且它
正在运行时，直接 `npm run tauri dev` 会有三个问题：

1. **起不来。** 单实例锁按应用 identifier（`com.floral-notepaper.app`）生效，调试实例
   会被已安装实例抢走锁后直接退出。
2. **污染数据。** 调试实例默认读写同一份配置与笔记目录，
   即 `%APPDATA%\floral-notepaper\config.json` 与 `Documents\花笺`。
3. **抢全局快捷键。** 两个实例注册同一个 `Alt+M` 会互相打架。

## 用法

```bash
npm run dev:isolated
```

等价于 `npm run tauri dev`，但会把三个环境变量指向隔离位置：

| 环境变量 | 作用 |
|---|---|
| `FLORAL_NOTEPAPER_CONFIG_DIR` | 配置目录 → `<项目>/.devdata/config` |
| `FLORAL_NOTEPAPER_DATA_DIR` | 笔记数据目录 → `<项目>/.devdata/notes` |
| `FLORAL_NOTEPAPER_NO_SINGLE_INSTANCE` | 设为 `1` 时跳过单实例插件（`src-tauri/src/lib.rs`） |

`.devdata/` 已在 `.gitignore` 里。

首次运行会从真实配置派生一份 `.devdata/config/config.json`，请检查其中：

- `globalShortcut` 与 `toggleVisibilityShortcut` 应为空
- `autostart` 应为 `false`
- `dataDir` 应指向 `.devdata/notes`

## 手动等价写法

```bash
export FLORAL_NOTEPAPER_CONFIG_DIR="$PWD/.devdata/config"
export FLORAL_NOTEPAPER_DATA_DIR="$PWD/.devdata/notes"
export FLORAL_NOTEPAPER_NO_SINGLE_INSTANCE=1
npm run tauri dev
```

## 覆盖构建期配置（临时）

端点之类写在 `tauri.conf.json` 里的东西是**构建期**读的，调试时不必改那个文件 ——
多出来的参数会原样转给 `tauri dev`，而 `tauri dev` 的 `--config <文件>` 会把那份 JSON
**合并**进配置：

```bash
npm run dev:isolated -- --config .devdata/market-override.json
```

临时文件放 `.devdata/`（已被 gitignore）。插件市场的本地沙箱
（`node scripts/market-sandbox.mjs`）就是这么接上去的，见 `Docs/plugin-market.md`。

## 不要做的事

- **不要** `npm run tauri build` 之后再运行产出的安装包 —— 那会覆盖已安装的正式版。
  仅构建（不安装）是安全的。
- 调试期间可以正常使用已安装的正式版，两者互不影响。
