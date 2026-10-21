/**
 * 目录树的**本机偏好**：展开到哪几层、用哪种显示方式。
 *
 * 为什么不进 `AppConfig`：它只是这台电脑上的浏览状态（换台机器重新展开很合理），
 * 与「工作文件夹列表」那种会跟随数据目录走的东西不是一回事。项目里别的窗口级偏好
 *（界面缩放、代码字体、PDF 导出设置）也都放在 localStorage。
 *
 * `WorkspaceTree` 被 `key={activeExplorer}` 整个重挂，所以这些值必须在模块外按根路径
 * 存住 —— 组件自己的 state 活不过切换。
 */

export type TreeDisplayMode = "list" | "cards" | "icons";

/** 旧版本只有 details / compact 两档，读回来时映射到新名字。 */
function normalizeDisplayMode(value: unknown): TreeDisplayMode | null {
  if (value === "list" || value === "cards" || value === "icons") return value;
  if (value === "compact") return "list";
  if (value === "details") return "cards";
  return null;
}

const EXPANDED_KEY = "floral.workspace.expanded";
const DISPLAY_MODE_KEY = "floral.workspace.displayMode";
/**
 * **按工作区**的「自动检测文件变化」开关。
 *
 * 默认关：轮询每个已经打开过的目录，工作区一大就是持续的后台 IO。用户明确要求
 * 「每个工作区单独设置，默认不启动」。
 */
const AUTO_REFRESH_KEY = "floral.workspace.autoRefresh";

function readRecord(key: string): Record<string, unknown> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeRecord(key: string, record: Record<string, unknown>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // 存储满了 / 被禁用：只是记不住展开状态，不影响使用。
  }
}

/** 某个工作区根下记住的展开路径。 */
export function readExpanded(root: string): string[] {
  const value = readRecord(EXPANDED_KEY)[root];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function writeExpanded(root: string, expanded: Iterable<string>): void {
  const record = readRecord(EXPANDED_KEY);
  const paths = [...expanded];
  if (paths.length === 0) {
    delete record[root];
  } else {
    record[root] = paths;
  }
  writeRecord(EXPANDED_KEY, record);
}

/** 某个工作区根的显示方式；没记过就是「卡片」。 */
export function readDisplayMode(root: string): TreeDisplayMode {
  return normalizeDisplayMode(readRecord(DISPLAY_MODE_KEY)[root]) ?? "cards";
}

export function writeDisplayMode(root: string, mode: TreeDisplayMode): void {
  const record = readRecord(DISPLAY_MODE_KEY);
  if (mode === "cards") {
    // 卡片是默认值，不必留一条记录。
    delete record[root];
  } else {
    record[root] = mode;
  }
  writeRecord(DISPLAY_MODE_KEY, record);
}

/** 这个工作区是否开启了「自动检测文件变化」；没记过就是 `false`。 */
export function readAutoRefresh(root: string): boolean {
  return readRecord(AUTO_REFRESH_KEY)[root] === true;
}

export function writeAutoRefresh(root: string, enabled: boolean): void {
  const record = readRecord(AUTO_REFRESH_KEY);
  if (enabled) {
    record[root] = true;
  } else {
    // 默认值不必留记录：文件里只剩「开着的」那些工作区。
    delete record[root];
  }
  writeRecord(AUTO_REFRESH_KEY, record);
}

/**
 * 把恢复出来的展开路径**限制在当前根里面**，并去掉根本身。
 *
 * 工作区被重新挂载到另一个位置、或者用户手工改过 localStorage 时，里面可能混进
 * 别的根的路径。按下标过滤一次，后面的 `load()` 就不会去列一个不相干的目录。
 */
export function filterExpandedPaths(root: string, paths: string[]): Set<string> {
  const separator = root.includes("\\") ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  const result = new Set<string>();
  for (const path of paths) {
    if (path === root) continue;
    if (path.startsWith(prefix)) result.add(path);
  }
  return result;
}

/**
 * 补上所有祖先目录。
 *
 * 只记住 `a/b/c` 是不够的：树是懒渲染的，`a` 没展开就不会渲染 `b`，`c` 自然永远
 * 看不见。恢复时把 `a`、`a/b` 一并放进展开集合。
 */
export function expandAncestors(root: string, paths: Iterable<string>): Set<string> {
  const separator = root.includes("\\") ? "\\" : "/";
  const rootWithSep = root.endsWith(separator) ? root : `${root}${separator}`;
  const result = new Set<string>();

  for (const path of paths) {
    if (!path.startsWith(rootWithSep)) continue;
    const rest = path.slice(rootWithSep.length);
    if (!rest) continue;

    const parts = rest.split(/[\\/]/).filter(Boolean);
    let current = root.endsWith(separator) ? root.slice(0, -1) : root;
    for (const part of parts) {
      current = `${current}${separator}${part}`;
      result.add(current);
    }
  }

  return result;
}
