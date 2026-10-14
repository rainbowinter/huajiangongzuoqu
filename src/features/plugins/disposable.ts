/**
 * 插件注册项的生命周期原语。
 *
 * 原实现的 `registerX` 全是「发射后不管」：往模块级数组里 push 一个函数就返回
 * `void`，既无法单独注销，也没有归属信息，只能靠 `clearAllPlugins()` 整体清空。
 * 后果是无法实现「卸载某一个插件」与「重载某一个插件」，插件热更新只能全量重建。
 *
 * 现在所有注册类 API 都返回 `Disposable`，由所属插件的 `DisposableStore` 统一持有，
 * 插件卸载时一次性释放。
 */

export interface Disposable {
  dispose(): void;
}

/** 把一个清理函数包装成幂等的 `Disposable`。 */
export function toDisposable(cleanup: () => void): Disposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    },
  };
}

/** 什么都不做的 Disposable，用于「注册被拒但仍然要给调用方一个句柄」的场景。 */
export const NOOP_DISPOSABLE: Disposable = { dispose() {} };

export function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Disposable).dispose === "function"
  );
}

/**
 * 一组 `Disposable` 的容器。
 *
 * 语义要点：
 * - `dispose()` 幂等，且**已释放之后再加进来的项会立刻被释放**——插件在卸载流程
 *   中途注册东西时不会泄漏。
 * - `remove()` 用于「提前释放其中一项」，同时把它从事务列表里摘掉。
 */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  get size(): number {
    return this.items.length;
  }

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.push(item);
    return item;
  }

  /** 注册一个清理函数并返回其 `Disposable`。 */
  addFn(cleanup: () => void): Disposable {
    return this.add(toDisposable(cleanup));
  }

  remove(item: Disposable): void {
    const index = this.items.indexOf(item);
    if (index >= 0) {
      this.items.splice(index, 1);
    }
    item.dispose();
  }

  /** 释放全部已登记的项，但商店本身仍可继续使用。 */
  clear(): void {
    const items = this.items;
    this.items = [];
    for (const item of items) {
      try {
        item.dispose();
      } catch (error) {
        // 单个注册项释放失败不应阻断其余项的释放
        console.error("[plugins] 释放注册项失败", error);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}
