/**
 * 构建前收尾：结束**本仓库 target 目录里**那个还在跑的构建产物。
 *
 * 原来的 `beforeBuildCommand` 是 `taskkill /F /IM floral-notepaper.exe` —— 按**镜像名**匹配。
 * 而「已安装的正式版」恰好也叫这个名字（`C:\Program Files\花笺\floral-notepaper.exe`），
 * 于是每次构建都会把用户正在用的那份应用一起杀掉。
 *
 * 构建其实只需要释放 `src-tauri/target/**` 下那个 exe 的文件锁，所以按**路径**过滤才对。
 * `taskkill` 没法按路径筛，因此写成这个脚本。
 *
 * 非 Windows 上什么都不做（Linux/macOS 的构建产物本来就不会被这样锁住）。
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(root, "src-tauri", "target").toLowerCase();

// 路径比较在 PowerShell 里做，避免把进程列表拉回 Node 再解析（编码、转义都是坑）。
const script = `
$target = '${targetDir.replace(/'/g, "''")}'
$victims = Get-CimInstance Win32_Process -Filter "Name='floral-notepaper.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($target)
  }
foreach ($process in $victims) {
  Write-Host "[build] 结束本地构建实例 PID $($process.ProcessId)（$($process.ExecutablePath)）"
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
`;

execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
  stdio: "inherit",
});
