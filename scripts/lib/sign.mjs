/**
 * 用 minisign 私钥给文件签名。应用发版与插件市场都用它。
 *
 * 签名走 Tauri CLI 自带的 `signer sign`（与应用自更新同一套密钥体系、同一套 `.sig` 格式），
 * 所以**不自己实现密码学**。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 私钥：环境变量优先，否则用给的默认位置。
 *
 * ⚠️ 环境变量名**只能是 `TAURI_SIGNING_PRIVATE_KEY`** —— Tauri CLI 只认这一个。
 */
export function resolvePrivateKey({ envName = "TAURI_SIGNING_PRIVATE_KEY", fallback }) {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return fallback;
}

export function assertPrivateKeyExists(privateKey) {
  // 环境变量里直接给了私钥内容（不是路径）时，不当路径检查。
  if (isKeyContent(privateKey)) return;
  if (!existsSync(privateKey)) {
    console.error(
      `找不到签名私钥：${privateKey}\n` +
        "用 `npx tauri signer generate -w <路径>` 生成，或用 TAURI_SIGNING_PRIVATE_KEY 指定。",
    );
    process.exit(1);
  }
}

/** 私钥是「内容」还是「路径」。CLI 对两者的接受方式是**互斥**的，给错会直接报错退出。 */
export function isKeyContent(value) {
  return value.includes("\n") || value.length > 500;
}

/**
 * 给一个文件签名，产出 `<文件>.sig`。
 *
 * ⚠️ **不给 `-p` 会交互式地问密码，然后一直挂着**（无密码也要显式给一个空串）。
 *
 * ⚠️ **私钥的两个来源不能同时给**：CLI 把环境变量 `TAURI_SIGNING_PRIVATE_KEY` 当作
 * `--private-key`，而我这里又要传 `-f`（`--private-key-path`）—— 两个一起来它会直接
 * `the argument '--private-key-path' cannot be used with '--private-key'` 退出（实测踩过，
 * 而且报错信息跟「签名失败」毫无关系，很容易查错方向）。所以：
 *
 * * 私钥是**内容** → 只走环境变量，不加 `-f`；
 * * 私钥是**路径** → 只走 `-f`，并把那个环境变量从子进程里摘掉。
 *
 * 用 node 直接跑 CLI 的 JS 入口，不走 `npx`：Windows 上 `.cmd` 不经 shell 是启动不了的
 * （execFileSync 会以 `pid: 0` 失败），而把 shell 打开又要操心一整套引号转义。
 */
export function signFile({ root, privateKey, password = "", file }) {
  const args = ["signer", "sign", "-p", password];
  const env = { ...process.env };
  // 两个都由下面显式传，留在环境里只会打架。
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;

  if (isKeyContent(privateKey)) {
    env.TAURI_SIGNING_PRIVATE_KEY = privateKey;
  } else {
    args.push("-f", privateKey);
  }
  args.push(file);

  execFileSync(process.execPath, [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), ...args], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** 读回签名，顺手 trim（`.sig` 末尾有换行，拼进 JSON 之前要去掉）。 */
export function readSignature(path) {
  return readFileSync(path, "utf8").trim();
}
