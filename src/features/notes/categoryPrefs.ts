/**
 * 笔记分类的折叠状态（本机偏好，跟 localStorage 走）。
 *
 * 存的不只是「哪些收起来了」，还有**当时有哪几个分类**：新出现的分类要默认折叠，
 * 而不是因为不在折叠清单里就自动展开。只存折叠清单的话，新建分类会突然撑开一大片。
 */

const STORAGE_KEY = "floral.notes.collapsedCategories";

interface StoredState {
  collapsed: string[];
  known: string[];
}

function readState(): StoredState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as { collapsed?: unknown; known?: unknown };
    return {
      collapsed: Array.isArray(record.collapsed)
        ? record.collapsed.filter((item): item is string => typeof item === "string")
        : [],
      known: Array.isArray(record.known)
        ? record.known.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** 这次启动时哪些分类该是收起的。没有存过 = 全部收起（保持旧行为）。 */
export function readCollapsedCategories(categories: readonly string[]): Set<string> {
  const state = readState();
  if (!state) return new Set(categories);

  const collapsed = new Set(state.collapsed);
  for (const category of categories) {
    if (!state.known.includes(category)) collapsed.add(category);
  }
  return collapsed;
}

export function writeCollapsedCategories(
  collapsed: ReadonlySet<string>,
  categories: readonly string[],
): void {
  if (typeof localStorage === "undefined") return;
  try {
    const state: StoredState = { collapsed: [...collapsed], known: [...categories] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 记不住折叠状态不影响使用。
  }
}
