import type { PluginRuntimeRecord } from "../plugins/types";

/**
 * 把插件清单拼成一份**给人看**的说明文档（类似插件自己的 README）。
 *
 * 内容是**从插件声明里现算的**，不要求插件作者额外写 README —— 装了一堆插件之后，
 * 「这个插件到底是干嘛的、动了哪些东西」应该点一下就能看到，而不是靠来回开关去试。
 *
 * 纯函数：调用方把已经数好的贡献点与设置项传进来，这里只负责排版。真正的数据要从
 * 好几个注册表里凑，那些不适合放进生成器（也没法在单测里造）。
 *
 * ⚠️ 生成的是**中文**文档。这与随包的 `Docs/user/*.md` 是同一个决定：面向使用者的说明
 * 目前只有中文版。界面本身是 i18n 的，文档不是 —— 将来要补多语言时，这两处要一起补。
 */

/** 一类贡献点（例如「面板」）以及它下面具体有哪几个。 */
export interface PluginContribution {
  label: string;
  items: string[];
}

export interface PluginSettingSummary {
  key: string;
  title: string;
  /** 控件类型（布尔 / 单选 / 文本……），直接照清单里的写法展示。 */
  type: string;
  description?: string;
}

export interface PluginDetailsInput {
  record: PluginRuntimeRecord;
  contributions: PluginContribution[];
  settings: PluginSettingSummary[];
}

/** 运行状态 → 给人看的一句话。 */
const STATUS_LABEL: Record<string, string> = {
  loaded: "运行中",
  disabled: "已停用",
  invalid: "清单有问题，没能加载",
  failed: "加载时出错",
  suspended: "因反复出错被暂时挂起",
  legacy: "运行中（旧版插件，没有独立运行环境）",
};

function bullet(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * 权限条目的可读化。
 *
 * 清单里是 `editor:write` 这样的机器名，纯贴出来一般人看不懂；这里把**没认出来的**
 * 单独标出来 —— 那才是值得看的部分（插件要了一个宿主不认识的东西）。
 */
function permissionLine(permission: string, granted: boolean): string {
  return granted ? `${permission}` : `${permission}（未生效）`;
}

export function buildPluginDetails({
  record,
  contributions,
  settings,
}: PluginDetailsInput): string {
  const { manifest, status, sandboxed, error } = record;
  const blocks: string[] = [];

  blocks.push(`# ${manifest.name}`);
  if (manifest.description) blocks.push(manifest.description);

  // ---------------------------------------------------------------- 基本信息
  const basics: string[] = [];
  basics.push(`| 版本 | \`${manifest.version || "未知"}\` |`);
  if (manifest.author) basics.push(`| 作者 | ${manifest.author} |`);
  if (manifest.homepage) basics.push(`| 主页 | ${manifest.homepage} |`);
  basics.push(`| 运行状态 | ${STATUS_LABEL[status] ?? status} |`);
  basics.push(
    `| 运行环境 | ${
      sandboxed
        ? "独立运行环境，插件出错不会影响花笺本身"
        : "与花笺共用进程（旧版插件），没有隔离"
    } |`,
  );
  basics.push(`| 安装目录 | \`${manifest.dirPath}\` |`);

  blocks.push(`## 基本信息\n\n| | |\n| --- | --- |\n${basics.join("\n")}`);

  if (error) blocks.push(`## 出错了\n\n\`\`\`text\n${error}\n\`\`\``);
  if (manifest.invalidReason) {
    blocks.push(`## 为什么没加载\n\n${manifest.invalidReason}`);
  }

  // ---------------------------------------------------------------- 权限
  const granted = new Set(manifest.grantedPermissions);
  if (manifest.permissions.length > 0) {
    const lines = manifest.permissions.map((permission) =>
      permissionLine(permission, granted.has(permission)),
    );
    blocks.push(
      `## 它要的权限\n\n${bullet(lines)}\n\n` +
        "权限决定插件能碰哪些东西（读写正文、访问文件、改样式……）。" +
        "标着「未生效」的是清单里声明了、但没能拿到的那几个。",
    );
  } else {
    blocks.push("## 它要的权限\n\n没有声明任何权限。");
  }

  if (manifest.warnings.length > 0) {
    blocks.push(`## 提醒\n\n${bullet(manifest.warnings)}`);
  }

  // ---------------------------------------------------------------- 贡献点
  const nonEmpty = contributions.filter((group) => group.items.length > 0);
  if (nonEmpty.length > 0) {
    const sections = nonEmpty.map(
      (group) => `**${group.label}**\n\n${bullet(group.items)}`,
    );
    blocks.push(
      `## 它在界面上加了什么\n\n${sections.join("\n\n")}\n\n` +
        "上面这些是它当前注册进来的东西；插件被停用时它们会一起消失。",
    );
  } else {
    blocks.push(
      "## 它在界面上加了什么\n\n这个插件没有往界面上加东西 —— 它可能只是改样式，" +
        "或者只在被命令调用时才做事。",
    );
  }

  // ---------------------------------------------------------------- 设置
  if (settings.length > 0) {
    const rows = settings.map((setting) => {
      const description = setting.description ? ` ${setting.description}` : "";
      return `### ${setting.title}\n\n\`${setting.key}\` · ${setting.type}${description}`;
    });
    blocks.push(`## 可以调的地方\n\n在插件面板里展开这个插件就能改。\n\n${rows.join("\n\n")}`);
  }

  return blocks.join("\n\n") + "\n";
}
