/**
 * 打 zip。应用发版与插件市场都用它。
 *
 * 优先用 7-Zip（装了的话）：它能在**指定目录里**执行，于是 zip 内部的路径就是我们要的
 * 相对路径 —— 这一点对插件特别要紧，约定是「zip 里恰好一层顶层目录，名字等于插件名」
 * （见 `Docs/plugin-market.md`）。PowerShell 的 `Compress-Archive` 只能作为兜底。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** @param {string} source 要打包的东西（文件或目录，绝对路径） */
export function makeZip(source, destination, options = {}) {
  const { cwd = dirname(source), quiet = false } = options;
  const sevenZip = join(process.env["ProgramFiles"] ?? "C:/Program Files", "7-Zip", "7z.exe");

  if (existsSync(sevenZip)) {
    // 在 `cwd` 里执行，好让 zip 内部的路径就是我们想要的那一层。
    execFileSync(sevenZip, ["a", "-tzip", destination, source], {
      cwd,
      stdio: quiet ? "ignore" : "inherit",
    });
    return;
  }

  if (process.platform !== "win32") {
    // `-j` 会把路径压平（只留文件名）—— 那正是应用发版要的：安装器在 zip 根上。
    execFileSync("zip", ["-j", "-q", destination, source], { stdio: quiet ? "ignore" : "inherit" });
    return;
  }

  mkdirSync(dirname(destination), { recursive: true });
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${source}' -DestinationPath '${destination}' -Force`,
    ],
    { stdio: quiet ? "ignore" : "inherit" },
  );
}
