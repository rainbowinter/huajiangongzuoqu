/**
 * 插件沙箱内部的引导程序。
 *
 * **传输无关**：既被真 Worker（`worker/sandbox.worker.ts`，包 `self`）使用，也被
 * 进程内环回使用。这一点很重要——否则测试就只能在浏览器里跑，而本项目的 vitest
 * 跑在 node 环境、没有 `Worker` 也没有 jsdom。
 *
 * 隔离边界是 **Worker 全局**，不是 `new Function`：worker 里没有 `window`、没有
 * `document`、没有 Tauri 的 `__TAURI_INTERNALS__`，`worker.terminate()` 可以掐死
 * 死循环。所以这里继续用 `new Function` 执行插件源码是安全的。
 */

import {
  HANDLER_PREFIX,
  serializeError,
  type EditorMirror,
  type HostToWorker,
  type MethodDescriptor,
  type PluginInfo,
} from "./protocol";
import type { WorkerSideTransport } from "./transport";
import { reviveElementRef } from "./elementRef";

type Handler = (...args: unknown[]) => unknown;

interface SandboxState {
  handlers: Map<string, Handler>;
  handlerSeq: number;
  api: Record<string, unknown>;
  onUnload: (() => unknown | Promise<unknown>) | null;
  mirror: EditorMirror;
  settings: Record<string, unknown>;
  callSeq: number;
  eventHandlers: Map<string, Set<Handler>>;
}

/** 把函数换成令牌；对象/数组递归处理。宿主永远拿不到插件函数。 */
function serializeArg(value: unknown, state: SandboxState): unknown {
  if (typeof value === "function") {
    const token = `${HANDLER_PREFIX}${state.handlerSeq++}`;
    state.handlers.set(token, value as Handler);
    return token;
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeArg(item, state));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = serializeArg(item, state);
    }
    return out;
  }

  return value;
}

/** 截断过长日志，避免插件把整篇文档打进日志里。 */
function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ")
    .slice(0, 2000);
}

function installConsoleCapture(transport: WorkerSideTransport): void {
  const levels = ["debug", "info", "warn", "error"] as const;

  for (const level of levels) {
    const original = console[level]?.bind(console);
    console[level] = (...args: unknown[]) => {
      original?.(...args);
      transport.post({ t: "log", level, message: formatLogArgs(args) });
    };
  }
}

/** 按 `ns.fn` 的命名空间把方法表摊成嵌套对象。 */
function buildProxiedNamespaces(
  methods: MethodDescriptor[],
  transport: WorkerSideTransport,
  state: SandboxState,
  call: (method: string, args: unknown[]) => Promise<unknown>,
): Record<string, Record<string, unknown>> {
  const namespaces: Record<string, Record<string, unknown>> = {};

  for (const descriptor of methods) {
    const [namespace, fn] = descriptor.name.split(".");
    if (!namespace || !fn) continue;

    (namespaces[namespace] ??= {})[fn] = (...args: unknown[]) => {
      const promise = call(
        descriptor.name,
        args.map((arg) => serializeArg(arg, state)),
      );

      // 注册类调用几乎都是「发射后不管」（`api.ui.registerPanel({...})` 不 await）。
      // 不在这里落日志的话，注册失败会**完全不可见**——连插件作者都无从知道，
      // 只会表现为"面板没出现"。
      //
      // 用 debug 级别：插件有意 catch 的失败（例如探测某个权限是否可用）不该刷屏。
      // 另外，挂了 catch 之后原生 promise 被标记为已处理，不会再冒未处理拒绝。
      promise.catch((error: unknown) => {
        transport.post({
          t: "log",
          level: "debug",
          message: `调用 ${descriptor.name} 失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });

      return promise;
    };
  }

  return namespaces;
}

/**
 * 构造插件可见的 `api` 对象。
 *
 * 大部分命名空间是「把调用转发给宿主」的普通函数，少数需要本地逻辑：
 * `plugin`（init 时下发的静态信息）、`log`（本地转发）、`events.on`（本地登记 +
 * 通知宿主订阅）、`editor.getContentSync/getSelectionSync`（读镜像，避免每次
 * 面板渲染都往返一次）。
 */
function buildApi(
  plugin: PluginInfo,
  methods: MethodDescriptor[],
  transport: WorkerSideTransport,
  state: SandboxState,
  call: (method: string, args: unknown[]) => Promise<unknown>,
): Record<string, unknown> {
  const namespaces = buildProxiedNamespaces(methods, transport, state, call);
  const { editor = {}, events = {}, plugin: pluginNamespace = {}, ...rest } = namespaces;

  const localLog =
    (level: "debug" | "info" | "warn" | "error") =>
    (...args: unknown[]) => {
      transport.post({ t: "log", level, message: formatLogArgs(args) });
    };

  return {
    ...rest,
    plugin: {
      // 方法表下发的 plugin.*（readAsset / listAssets）必须一起展开，否则下面这个
      // 字面量会把整个命名空间**整体覆盖**掉，插件侧看到 `api.plugin.readAsset`
      // 是 undefined。静态字段放在后面，避免插件用同名方法顶掉 id / version。
      ...pluginNamespace,
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      apiVersion: plugin.apiVersion,
      permissions: plugin.permissions,
      grantedPermissions: plugin.grantedPermissions,
      locale: plugin.locale,
    },
    log: {
      debug: localLog("debug"),
      info: localLog("info"),
      warn: localLog("warn"),
      error: localLog("error"),
    },
    editor: {
      ...editor,
      /** 读镜像内容：同步、无往返。这是让「渲染时同步读内容」的老写法能迁移过来的关键。 */
      getContentSync: () => state.mirror.content,
      getSelectionSync: () => state.mirror.selection,
      getCursorSync: () => state.mirror.cursor,
      getActiveNoteIdSync: () => state.mirror.activeNoteId,
      /**
       * 当前文件身份：`{ path, typeId, kind, language }`，笔记或未被认领的格式为
       * `null`。同步可用是因为读的是本地镜像，不走往返。
       */
      getFileSync: () => state.mirror.file,
    },
    events: {
      /**
       * 事件是宿主推送过来的，插件侧只在本地登记回调。
       * 首个订阅者出现时才通知宿主订阅，避免推送无人接收的事件。
       */
      on: (topic: unknown, handler: unknown) => {
        if (typeof topic !== "string" || typeof handler !== "function") {
          return { dispose() {} };
        }
        let set = state.eventHandlers.get(topic);
        if (!set) {
          set = new Set();
          state.eventHandlers.set(topic, set);
          void call("events.subscribe", [topic]).catch(() => undefined);
        }
        set.add(handler as Handler);

        let disposed = false;
        return {
          dispose() {
            if (disposed) return;
            disposed = true;
            const current = state.eventHandlers.get(topic);
            if (!current) return;
            current.delete(handler as Handler);
            if (current.size === 0) {
              state.eventHandlers.delete(topic);
              void call("events.unsubscribe", [topic]).catch(() => undefined);
            }
          },
        };
      },
    },
    settings: {
      get: async () => state.settings,
    },
  };
}

function handleInvoke(
  state: SandboxState,
  message: Extract<HostToWorker, { t: "invoke" }>,
  transport: WorkerSideTransport,
): void {
  const handler = state.handlers.get(message.handler);
  if (!handler) {
    transport.post({
      t: "invokeReply",
      id: message.id,
      ok: false,
      error: {
        code: "handlerNotFound",
        message: `插件回调不存在或已释放：${message.handler}`,
      },
    });
    return;
  }

  void Promise.resolve()
    // 参数先过一遍还原：宿主送 DOM 相关的参数时只能送裸数据，这里补回方法。
    .then(() => handler(...message.args.map(reviveElementRef)))
    .then(
      (value) => {
        transport.post({ t: "invokeReply", id: message.id, ok: true, value });
      },
      (error: unknown) => {
        transport.post({
          t: "invokeReply",
          id: message.id,
          ok: false,
          error: serializeError(error, "pluginCallbackFailed"),
        });
      },
    );
}

function dispatchEvent(state: SandboxState, topic: string, payload: unknown): void {
  if (topic === "editor.mirror") {
    state.mirror = payload as EditorMirror;
    return;
  }
  if (topic === "settings.changed") {
    state.settings = (payload as Record<string, unknown>) ?? {};
    // **不 return**：这一条除了更新快照，插件也常常要跟着改点什么（行号插件就是
    // 把栏宽重新注册一遍）。吃掉事件等于让 `api.events.on("settings.changed")`
    // 永远不触发。
  }

  const set = state.eventHandlers.get(topic);
  if (!set) return;

  for (const handler of [...set]) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[plugin] 事件 ${topic} 的处理函数抛错`, error);
    }
  }
}

/**
 * 启动沙箱。返回一个 promise，在 `dispose` 之后 resolve。
 *
 * 契约：宿主必须先发 `init`（含插件源码与权限），沙箱才会执行插件代码。
 */
export function runPluginSandbox(transport: WorkerSideTransport): Promise<void> {
  installConsoleCapture(transport);

  return new Promise<void>((resolve) => {
    const state: SandboxState = {
      handlers: new Map(),
      handlerSeq: 0,
      api: {},
      onUnload: null,
      mirror: {
        content: "",
        selection: null,
        cursor: 0,
        activeNoteId: null,
        contentEpoch: 0,
        file: null,
      },
      settings: {},
      callSeq: 0,
      eventHandlers: new Map(),
    };

    let settled = false;

    const call = (method: string, args: unknown[]): Promise<unknown> => {
      const id = state.callSeq++;
      return new Promise<unknown>((resolveCall, rejectCall) => {
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        transport.post({ t: "call", id, method, args });
      });
    };

    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: unknown) => void }
    >();

    transport.subscribe((message) => {
      switch (message.t) {
        case "init": {
          const code = message.code;
          state.mirror = message.mirror;
          state.settings = message.settings ?? {};
          state.api = buildApi(message.plugin, message.methods, transport, state, call);

          const floral = {
            register(definition: {
              onLoad?: (api: Record<string, unknown>) => unknown;
              onUnload?: () => unknown;
            }) {
              state.onUnload = definition.onUnload ?? null;
              return Promise.resolve()
                .then(() => definition.onLoad?.(state.api))
                .then(
                  () => {
                    transport.post({ t: "loaded" });
                  },
                  (error: unknown) => {
                    transport.post({
                      t: "loadFailed",
                      error: serializeError(error, "pluginLoadFailed"),
                    });
                  },
                );
            },
          };

          try {
            const factory = new Function("floral", code) as (floral: unknown) => void;
            factory(floral);
          } catch (error) {
            transport.post({
              t: "loadFailed",
              error: serializeError(error, "pluginSyntaxError"),
            });
          }
          transport.post({ t: "ready" });
          break;
        }

        case "reply":
          {
            const entry = pending.get(message.id);
            if (!entry) break;
            pending.delete(message.id);
            if (message.ok) {
              entry.resolve(message.value);
            } else {
              entry.reject(Object.assign(new Error(message.error.message), message.error));
            }
          }
          break;

        case "invoke":
          handleInvoke(state, message, transport);
          break;

        case "event":
          dispatchEvent(state, message.topic, message.payload);
          break;

        case "dispose": {
          void Promise.resolve()
            .then(() => state.onUnload?.())
            .catch((error: unknown) => {
              console.error("[plugin] onUnload 抛错", error);
            })
            .then(() => {
              for (const entry of pending.values()) {
                entry.reject(Object.assign(new Error("插件已卸载"), { code: "transportClosed" }));
              }
              pending.clear();
              state.handlers.clear();
              state.eventHandlers.clear();
              transport.post({ t: "disposed" });
              if (!settled) {
                settled = true;
                resolve();
              }
            });
          break;
        }

        default:
          break;
      }
    });
  });
}
