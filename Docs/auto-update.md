# 应用自更新

用 Tauri 官方的 `tauri-plugin-updater`。它去读一个静态 JSON 比对版本、下载、**校验签名**、
安装、重启。服务器端只要能发这个 JSON 就行 —— GitHub Release、任意静态托管都可以。

> 别和 `src-tauri/src/updater/` 混了：那个是上游自带的、**已停用**的一整套更新器实现
> （当年指向 `Achilng/floral-notepaper` 与 Mirror酱，真走完会把上游代码装进来、覆盖掉本仓库
> 的全部改动，所以停用了）。现在这套走官方插件，端点在 `tauri.conf.json` 里，由
> `src-tauri/src/selfupdate.rs` 读出来给前端做开关。

## 默认是关着的

`tauri.conf.json` 里那个数组**默认为空**：

```jsonc
"plugins": {
  "updater": {
    "endpoints": [],          // ← 空 = 这个功能整体关闭
    "pubkey": "……"            // 公钥，可以公开
  }
}
```

空的时候**不会发起任何请求**，界面上也不会出现任何东西（前端先问 `update_endpoint` 命令，
拿到 `null` 就整条流程不启动）。所以现在装着是「静默待命」，不会给任何人添乱。

要启用就把端点填进去：

```jsonc
"endpoints": ["https://github.com/<用户名>/<仓库>/releases/latest/download/latest.json"]
```

`latest.json` 长这样（`platforms` 的键是目标三元组）：

```json
{
  "version": "2.0.1",
  "notes": "这一版改了什么",
  "pub_date": "2026-10-15T11:30:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "……（.sig 文件的全部内容）",
      "url": "https://……/花笺_2.0.1_x64-setup.exe.zip"
    }
  }
}
```

## 三条硬约束

### 1. 端点**必须**是 https

更新器会校验协议：**release 构建里非 https 直接拒绝**（debug 构建只警告）。
本地调试要么用 debug 构建，要么临时开 `dangerousInsecureTransportProtocol` —— 那是
**调试用的**，不要出现在正式配置里。

### 2. 签名密钥是一次的，丢了就完了

更新**强制验签，关不掉**。公钥在配置里（可以公开），私钥打包时用环境变量给：

```bash
export TAURI_SIGNING_PRIVATE_KEY="<私钥内容或路径>"   # 这个 CLI 版本只认这个名字
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""          # 生成时没设密码就不用给
```

> ⚠️ **私钥丢了，所有已装用户就再也收不到更新了。** 本机那份在
> `C:\Users\Administrator\.tauri\floral-notepaper.key`，**请自己备份好**（别提交进仓库）。
> `.env` 文件对签名**不生效**，必须是真环境变量。

### 3. 已经发出去的版本收不到

1.0.7 和**已经发出去的 2.0.0** 都没有更新器。自动更新只对「从改造之后装的版本」生效 ——
这一版仍然要**手动发一次**安装包。

## 发布：产物长什么样

更新器要的不是安装器本身，而是一个**装着安装器的 zip**，外加它的签名。Windows 上的结构：

```
花笺_2.0.1_x64-setup.exe.zip          # 外层 zip
  └── 花笺_2.0.1_x64-setup.exe        # 里面就是 NSIS 安装器
花笺_2.0.1_x64-setup.exe.zip.sig      # minisign 签名（内容原样填进 latest.json 的 signature）
```

**一条命令产出**（`scripts/release.mjs`）：

```bash
npm run release                                  # 构建 + 打包 + 签名 + 写 latest.json
npm run release -- --repo 用户名/仓库             # 顺带把 latest.json 里的 URL 写对
npm run release -- --skip-build                  # 产物不满意时，不重新构建只重出
```

产物全在 `src-tauri/target/release/bundle/nsis/`，脚本最后会把要上传的四个文件列出来。
`FLORAL_RELEASE_NOTES` 环境变量可以塞版本说明（会进 `latest.json` 的 `notes`）。

私钥默认取 `~/.tauri/floral-notepaper.key`，也可以用 `TAURI_SIGNING_PRIVATE_KEY` 指定。

> ⚠️ 自己调 `signer sign` 时注意：它会**交互式地要密码**，不给 `-p` 会一直挂着。
> 密钥没设密码就传 `-p ""`。（`release.mjs` 里已经处理好了。）

> ❓ **`bundle.createUpdaterArtifacts: true` 目前没生效**：配置是对的、CLI 也认识这个字段
> （二进制里有），但 `tauri build` 只产出安装器、不产出上面那个 zip —— 所以 `release.mjs`
> 自己做了打包与签名这一步。这条路径**已端到端验证**（应用真的下载下来并通过了签名校验）。
> 怀疑是 tauri-cli 2.10.1 与 tauri 2.12.4 / 插件 2.14 之间的代差，**升级 CLI 之后值得再试
> 一次**；真生效了就可以把脚本里的打包步骤去掉。

> ⚠️ **发布资产必须用纯 ASCII 文件名**（`release.mjs` 已经这么做了）。Tauri 打出来的安装器
> 叫 `花笺_<版本>_x64-setup.exe`，**这个中文名不能直接上传到 GitHub Release**：
> 实测 v2.0.1 首发时 GitHub 把开头的「花笺」吃掉了，实际存成 `_2.0.1_x64-setup.exe.zip`，
> 于是 `latest.json` 里写的 URL 直接 **404** —— 更新器什么也下载不到，
> 而且这个失败是**静默的**，界面上不会有任何反应。
> 所以脚本会把产物复制成 `floral-notepaper_<版本>_x64-setup.*` 再让你上传，
> 上传时也**不要改名**：资产名必须与 `latest.json` 里 `url` 的最后一段逐字一致。

## 调试

- 端到端验证需要**两个版本**：把应用指向一个比它自己版本更高的 `latest.json` 即可
  （伪造一个 `9.9.9` 也行，不必真打包两个版本）。
- 没有 GUI 能点的时候（主窗口是 `visible: false` 的托盘窗口，工具点不到），
  可以让前端往本地服务器打请求，用**服务器访问日志**当证据链 —— 能直接看到
  `GET /latest.json`、`GET /<产物>`，以及状态机的迁移。
- 本地起服务：`python -m http.server 8788 --bind 127.0.0.1`，产物用 ASCII 文件名伺服，
  避开 URL 里的中文编码问题。

## 版本号与依赖对齐（踩过的坑）

`tauri-cli` 会核对「Rust crate」与「npm 包」的 major/minor 是否一致，不一致**直接拒绝构建**：

- `tauri` ↔ `@tauri-apps/api`
- 每个 `tauri-plugin-*` ↔ 对应的 `@tauri-apps/plugin-*`

所以加/升插件时**两边必须一起动**。当前钉的是：tauri `~2.12`、updater `~2.14`、process `~2.4`。

另外：往 `Cargo.toml` 里加任何新依赖都会触发重新解析，`tauri = "2"` 会被顶到当时的最新
（2.12.x），于是和 npm 侧对不上 —— 所以两边都用 `~` 钉住次版本。
