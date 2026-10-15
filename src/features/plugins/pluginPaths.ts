/**
 * 插件目录的路径识别。
 *
 * 插件的私有目录固定是 `<数据目录>/plugins/<插件名>/`（规矩定在 Rust 侧的
 * `plugins/paths.rs`）。这里**只做识别**：判断一个路径属不属于哪个插件。真正的读写与
 * 路径穿越防护全在后端，不要在这里补校验 —— 两条判据分家比一条更危险。
 *
 * 用途见 `MainWindow` 的保存路径：在花笺里保存插件的样式表之后，据此告诉那个插件
 * 「你的资源变了」（事件 `plugin:assetsChanged`）。
 */

/** 路径尾部斜杠与分隔符统一，方便前缀比较。 */
function normalize(path: string): string {
  return path.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
}

/**
 * 返回这个路径所属插件的名字；不在任何插件目录里则返回 `null`。
 *
 * ⚠️ 只取**第一段**做名字，不做前缀拆分：`plugins/abc-extra/x.css` 属于插件
 * `abc-extra`，不能被误判成 `abc`。也正因如此，这里比对的是拼接后的
 * `<数据目录>/plugins/`，而不是靠字符串包含。
 */
export function pluginOwningPath(dataDir: string, path: string): string | null {
  if (!dataDir || !path) return null;

  const root = `${normalize(dataDir)}/plugins/`;
  const target = normalize(path);

  if (target.length <= root.length) return null;
  // Windows 上路径大小写不敏感，前缀比对统一折成小写；返回的仍是原样的那一段。
  if (!target.toLowerCase().startsWith(root.toLowerCase())) return null;

  const rest = target.slice(root.length);
  const slash = rest.indexOf("/");
  // 没有第二段，说明这个文件直接躺在 `plugins/` 下、不属于任何插件。
  if (slash <= 0) return null;

  return rest.slice(0, slash);
}
