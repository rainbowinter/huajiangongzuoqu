/**
 * 权限词汇表与权限门。
 *
 * 词汇表**只存在于这里**：Rust 侧把 `permissions` 当作不透明字符串数组存取，
 * 因此新增一个权限点只需要改这个文件和 `methodTable.ts`，不必同时改后端。
 *
 * 门必须设在**宿主侧**。worker 是被隔离方，让它自查权限等于没有权限。唯一的
 * 检查入口是 `methodTable.ts` 的调用包装器，这样就不会出现「加了新方法忘了加门」
 * ——配套单测会断言：方法表里凡是需要能力的方法都必须声明 `permission`。
 */

export const PERMISSIONS = [
  "workspace:read",
  "workspace:write",
  "categories:read",
  "categories:write",
  "editor:read",
  "editor:write",
  "ui:toast",
  "ui:panel",
  "ui:command",
  "ui:statusbar",
  "ui:menus",
  "ui:toolbar",
  "ui:open-panel",
  "events",
  "storage",
  "settings",
  "system:clipboard:read",
  "system:clipboard:write",
  "system:open-external",
  "system:dialog",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

/** 蕴含关系：授予前者即同时获得后者。 */
const IMPLIES: Partial<Record<Permission, readonly Permission[]>> = {
  "workspace:write": ["workspace:read"],
  "categories:write": ["categories:read"],
  "editor:write": ["editor:read"],
  // 注意：剪贴板写**不**蕴含读。能往剪贴板写不代表有权读取用户剪贴板内容。
};

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/** 从声明列表里挑出宿主不认识的权限，用于给插件作者明确反馈。 */
export function unknownPermissions(declared: readonly string[]): string[] {
  return declared.filter((permission) => !isPermission(permission));
}

/**
 * 判断某个权限是否已生效。
 *
 * 两步：
 *
 * 1. 先算出**有效授予集** = 授予列表 ∩ 清单声明。这一步保证了默认拒绝——
 *    未在清单里声明的权限一律不生效，即便状态文件把它写进了授予列表
 *    （那样的情况只可能来自被篡改或过期的状态）。
 * 2. 再看有效授予集是否直接包含目标权限，或经 IMPLIES 蕴含覆盖。
 *
 * ⚠️ 第 2 步必须建立在第 1 步的结果上，**不能**反过来要求「目标权限本身被声明」——
 * 否则 `editor:write` 蕴含 `editor:read` 永远不成立（插件通常只声明 write）。
 */
export function isGranted(
  declared: readonly string[],
  granted: readonly string[],
  permission: Permission,
): boolean {
  const effective = granted.filter(
    (candidate): candidate is Permission =>
      isPermission(candidate) && declared.includes(candidate),
  );

  if (effective.includes(permission)) return true;

  return effective.some((candidate) => IMPLIES[candidate]?.includes(permission));
}

export class PermissionError extends Error {
  readonly code = "permissionDenied";
  readonly details: Record<string, string>;

  constructor(
    readonly permission: Permission,
    readonly method: string,
    readonly plugin: string,
  ) {
    super(`插件 ${plugin} 未获得权限 ${permission}（调用 ${method} 被拒绝）`);
    this.name = "PermissionError";
    this.details = { permission, method, plugin };
  }
}

export function checkPermission(
  declared: readonly string[],
  granted: readonly string[],
  permission: Permission,
  method: string,
  plugin: string,
): void {
  if (!isGranted(declared, granted, permission)) {
    throw new PermissionError(permission, method, plugin);
  }
}
