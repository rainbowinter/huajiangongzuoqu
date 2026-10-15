# 插件市场的发布源

这个目录里放**清单的源文件**：`plugin-catalog.json`。它由发布脚本维护，应该提交进仓库 ——
发布过什么、每个插件的 sha256 是多少，都在这份文件的历史里。

```bash
npm run plugin -- --dir example-plugins-v2/<插件名> --repo <用户名>/<插件仓库> [--upload]
```

第一次发布时脚本会自己建这份文件；之后的每次发布会往里面加一版、并把 `catalogVersion`
抬一格（应用靠它挡回滚）。

`dist/`（打好的 zip）与 `*.sig`（签名）都是**产物**，可以随时重新生成，所以不进版本库。

完整说明见 [`../Docs/plugin-market.md`](../Docs/plugin-market.md)。
