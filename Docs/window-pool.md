# 记事本窗口的预热池与闲置回收

管的是「快速记事本窗口开得快不快」和「挂后台时占多少内存」这两件事的平衡。
代码全在 `src-tauri/src/desktop.rs`。

## 预热池是什么

`NOTEPAD_POOL_CAPACITY = 2`：应用启动后会**预先建好 2 个隐藏的记事本窗口**
（`schedule_notepad_prewarm`，启动后 800ms / 1200ms 各建一个）。用户按快捷键要开快速
记事本时，直接 `show()` 一个已经建好的，而不是现建 —— 现建一个 WebView 窗口要等
几百毫秒，那个延迟体感很明显。

窗口关掉时走的是 `recycle_notepad_window`：`hide()` 之后放回池子，而不是销毁。

## 代价：一个窗口 ≈ 一个渲染进程

**这是最容易看错的地方。** 任务管理器里「花笺」那一行显示的是**宿主进程**，通常只有
二三十 MB —— 但它不是应用的真实占用。真正的开销在 WebView2 的子进程上，而
Windows 10 的任务管理器默认不把它们并到应用名下面。实测（macOS/Windows 同理）：

| 进程 | 私有内存 |
|---|---|
| `floral-notepaper.exe`（宿主） | ~26 MB |
| WebView2 浏览器进程 | ~95 MB |
| 每个渲染进程（一个窗口一个） | ~100 MB（主窗口可能大得多） |

也就是说**光是预热池就常驻约 200MB**，哪怕用户一个记事本都没开。

## 闲置回收

所以加了 `watch_idle_and_reclaim`：一个 30 秒醒一次的看门线程，走主线程检查。

- **只要有任意一个窗口可见** → 用户正在用，什么都不做；
- **所有窗口都藏起来，且持续满 `IDLE_RECLAIM_AFTER`（5 分钟）** → 把池子里的窗口
  **真正 `close()`** 掉，把这些渲染进程交还给系统；
- **此后只要有窗口重新可见** → 立刻按原样补预热，秒开照旧。

判定逻辑抽成了纯函数 `idle_pool_action`（输入：有没有可见窗口、闲置了多久、池子里几个、
是否已抑制），单测覆盖了各条分支 —— 真正的窗口操作没法在单测里跑。

几个刻意的选择：

- **刚藏起来的那一刻不回收**（`idle_for` 为 `None`）。用户可能只是切了个窗口，马上回来；
  要销毁得「一直没人用」满 5 分钟。
- **`prewarm_suppressed` 立旗子先于 `close()`**。`close()` 会派发窗口事件，那期间任何一次
  预热都该被挡掉，否则会把刚腾出来的内存又填回去，回收等于白做。`prewarm_notepad` 开头
  也据此直接返回。
- **回收后不重复动作**：已经抑制过就保持安静，不然每个 tick 都白跑一趟。

## 调参

想改回收得早/晚，改 `src-tauri/src/desktop.rs` 里的两个常量：

```rust
const IDLE_RECLAIM_AFTER: Duration = Duration::from_secs(5 * 60);  // 闲置多久回收
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(30);      // 多久检查一次
const NOTEPAD_POOL_CAPACITY: usize = 2;                             // 预热几个
```

把 `NOTEPAD_POOL_CAPACITY` 改成 `0` 就是不预热（最省内存，代价是第一次开记事本窗口
要现建）。改成 `1` 是折中。

## 怎么验证

**别看任务管理器里「花笺」那一行** —— 那一行是宿主进程，看不出问题。要看进程树：

```bash
# 花笺 名下所有进程（含 WebView2 子进程）
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -like '*floral*' -or \$_.Name -eq 'msedgewebview2.exe' } | Select-Object Name,ProcessId,ParentProcessId"
```

判断归属看 `ParentProcessId` 能不能追到 `floral-notepaper.exe`。

想验闲置回收：启动时加 `--silent`（不显示主窗口），这样从一开机就是闲置状态；
5 分钟后预热的那两个渲染进程应当消失，再用托盘唤起主窗口，它们应当回来。
