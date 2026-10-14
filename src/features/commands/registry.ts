/**
 * 统一命令表与键位匹配。
 *
 * 存在的理由：改造前 `addPluginCommand` 注册的命令**没有任何 UI 消费方**
 * （`listPluginCommands` 全项目零调用方），插件注册了命令却无处可点。这里提供
 * 两件缺的东西——一个能列出并执行命令的面板，以及一套键位绑定。
 *
 * 内置命令与插件命令共用同一套展示/执行路径，避免再出现「只注册不消费」。
 */

import { toDisposable, type Disposable } from "../plugins/disposable";
import { listPluginCommands, subscribePluginCommands } from "../plugins/registry";

export interface CommandEntry {
  id: string;
  title: string;
  /** 来源：`"builtin"` 或插件名。 */
  source: string;
  keybinding?: string;
  run: () => void | Promise<void>;
}

const builtinCommands: CommandEntry[] = [];
const listeners = new Set<() => void>();

/**
 * `listCommands()` 的快照缓存。
 *
 * ⚠️ 与 `plugins/registry.ts` 里同样的原因：这个数组直接喂给
 * `useSyncExternalStore`，每次返回新数组会让 React 判定快照持续变化，
 * 进而无限重渲染。只在真正变化时重建。
 */
let snapshot: readonly CommandEntry[] = Object.freeze([]);
let snapshotDirty = true;

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("[commands] 订阅回调抛错", error);
    }
  }
}

function invalidate(): void {
  snapshotDirty = true;
  notify();
}

// 插件命令增删时，合并后的列表也要失效。
subscribePluginCommands(() => {
  snapshotDirty = true;
  notify();
});

export function registerBuiltinCommand(entry: Omit<CommandEntry, "source">): Disposable {
  const command: CommandEntry = { ...entry, source: "builtin" };
  builtinCommands.push(command);
  invalidate();

  return toDisposable(() => {
    const index = builtinCommands.indexOf(command);
    if (index < 0) return;
    builtinCommands.splice(index, 1);
    invalidate();
  });
}

/** 返回稳定引用的快照；仅在命令集合变化时才会换新数组。 */
export function listCommands(): readonly CommandEntry[] {
  if (snapshotDirty) {
    snapshot = Object.freeze([...builtinCommands, ...listPluginCommands().map(toEntry)]);
    snapshotDirty = false;
  }
  return snapshot;
}

function toEntry(command: {
  id: string;
  title: string;
  plugin: string;
  keybinding?: string;
  run: () => void | Promise<void>;
}): CommandEntry {
  return {
    id: command.id,
    title: command.title,
    source: command.plugin,
    ...(command.keybinding ? { keybinding: command.keybinding } : {}),
    run: command.run,
  };
}

export function subscribeCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 仅供测试。 */
export function clearBuiltinCommands(): void {
  builtinCommands.length = 0;
  invalidate();
}

// ------------------------------------------------------------ 键位匹配

/**
 * 解析键位字符串。
 *
 * 支持 `Ctrl` / `Cmd` / `CmdOrCtrl` / `Alt` / `Shift` + 一个主键。
 * `CmdOrCtrl` 在 macOS 上映射到 Cmd，其余平台映射到 Ctrl。
 */
interface ParsedBinding {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function parseKeybinding(binding: string): ParsedBinding | null {
  const parts = binding
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const parsed: ParsedBinding = {
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    key: "",
  };

  const isMac =
    typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

  for (const part of parts) {
    const token = part.toLowerCase();
    switch (token) {
      case "ctrl":
      case "control":
        parsed.ctrl = true;
        break;
      case "cmd":
      case "meta":
      case "command":
        parsed.meta = true;
        break;
      case "cmdorctrl":
      case "mod":
        if (isMac) parsed.meta = true;
        else parsed.ctrl = true;
        break;
      case "alt":
      case "option":
        parsed.alt = true;
        break;
      case "shift":
        parsed.shift = true;
        break;
      default:
        // 主键。注意：以 "+" 分隔的解析方式**无法**表达 "+" 键本身
        // （"Ctrl++" 会被切成 "Ctrl" 与两个空串）。这是已知限制，不是疏忽。
        parsed.key = part.toLowerCase();
        break;
    }
  }

  return parsed.key ? parsed : null;
}

/**
 * 按键事件的最小结构。
 *
 * 不用 `KeyboardEvent` 是因为 React 的合成事件（`React.KeyboardEvent`）并不满足
 * 原生 `KeyboardEvent` 的完整接口，而调用方确实来自 textarea 的 `onKeyDown`。
 * 两边都满足这个结构，因此无需在调用点做类型断言。
 */
export interface KeybindingEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  preventDefault(): void;
}

/** 判断一次按键是否匹配某个键位绑定。 */
export function matchKeybinding(event: KeybindingEvent, binding: string): boolean {
  const parsed = parseKeybinding(binding);
  if (!parsed) return false;

  if (event.ctrlKey !== parsed.ctrl) return false;
  if (event.metaKey !== parsed.meta) return false;
  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift) return false;

  return event.key.toLowerCase() === parsed.key;
}

/** 把键位渲染成适合展示的形式。 */
export function formatKeybinding(binding: string): string {
  const parsed = parseKeybinding(binding);
  if (!parsed) return binding;

  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("Cmd");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  return parts.join("+");
}

/**
 * 尝试用插件命令的键位处理一次按键。
 *
 * 返回 `true` 表示已接管该事件。调用方应在内置快捷键（`handleMarkdownShortcut`）
 * **之后**调用，让内置快捷键优先——否则插件可以用一个键位把 Ctrl+B 抢走。
 *
 * 命令本身是异步的，但这里必须同步返回是否接管，因此先 `preventDefault()` 再放走
 * Promise。
 */
export function dispatchCommandKeybinding(event: KeybindingEvent): boolean {
  for (const command of listCommands()) {
    if (!command.keybinding) continue;
    if (!matchKeybinding(event, command.keybinding)) continue;

    event.preventDefault();
    void Promise.resolve()
      .then(() => command.run())
      .catch((error: unknown) => {
        console.error(`[commands] 执行命令 ${command.id} 失败`, error);
      });
    return true;
  }
  return false;
}
