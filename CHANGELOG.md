# 更新日志

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.7 — 2026-07-07

源码模式自动装 Bun 的 UX 改进：装之前给醒目提示、安装过程逐行流式输出、装完给结果。

### 改进
- `bin/launcher.cjs` 改异步流式：
  - 检测不到 Bun 时先打印提示（「未检测到 Bun 运行时，首次自动安装中（约 10-30s）」+ 日志路径，可另开终端 `tail -f` 看实时进度）。
  - 安装命令（`npm i -g bun` / 官方脚本）的 stdout/stderr 逐行流式 → 同时写 `bun-install.log` 和（仅 SessionStart）hook stdout，安装完成后用户能看到完整进度。
  - 成功打印「Bun 就绪，继续启动…」；失败打印手装指引。退出码恒 0。
- 说明：Claude Code 的 hook stdout 是 hook 跑完后整体展示，TUI 内做不到逐行实时刷；要真·实时就 `tail -f` 日志文件。

### 验证
Kali 实测：临时隐藏 Bun 后跑 SessionStart → 见提示 → npm 流式进度（`changed 5 packages in 8s`）→ ✅ → Dashboard 链接；`bun-install.log` 有完整输出、daemon `ingest`、bun 正常回来。Bun 在时不触发安装（无回归，`bun-install.log` 不生成）。

## 0.2.6 — 2026-07-07

源码模式（`/plugin install` 或 `/plugin marketplace add`）**自动安装 Bun**：以前没装 Bun 时 launcher 静默退出、daemon 不起；现在首次 SessionStart 检测不到 Bun 就自动装。

### 新增
- `bin/launcher.cjs` 源码模式下：`findBun()`（PATH + `~/.bun/bin`、`/usr/local/bin`、`/opt/homebrew/bin`）检测不到 Bun 时，`installBun()` 自动安装——`npm i -g bun`（走已配 registry/镜像）→ 失败回退官方脚本（Windows PowerShell / Unix curl）。装完再 `bun run src/hook/main.ts`。安装输出写 `bun-install.log` 不污染 hook stdout；退出码恒 0；SessionStart 打印一行进度。
- `hooks.json` SessionStart 加 `timeout: 200`，给首次装 Bun 留足时间（其它 hook 不变）。

### 验证
Kali（Bun 已在）实测无回归：新 launcher 仍走 `bun run`、daemon 正常 `ingest http SessionStart`、未误触发安装（`bun-install.log` 不生成）。

## 0.2.5 — 2026-07-07

npm/plugin 元数据（repository / homepage / bugs）由 aliyun 改指 GitHub；`plugin.json` version 同步（原长期停在 0.1.13）。无代码逻辑变更。

## 0.2.4 — 2026-07-07

首个 **npm 一键安装完全可用** 的版本。修掉 0.2.0–0.2.3 在安装链路上陆续暴露的 5 个 bug。

### 修复（安装链路）

- **install CLI 自定位找包根**：`findPackageRoot` 改用 `realpathSync(process.argv[1])`。
  - 0.2.0：`import.meta.url` 被 Bun cjs bundle 静态固化为**构建机的绝对路径** → 他机部署源指向不存在的目录。
  - 0.2.1：改用 `process.argv[1]` 后，npx 下它是 `node_modules/.bin/<pkg>` **符号链接**，`path.resolve` 不解析符号链接 → 部署源错指到 `node_modules`、白名单拷空。
  - 0.2.2 起：`realpathSync` 解析符号链接到真实 `dist/install.cjs`，正确命中包根。
- **插件加载失败「Plugin not found in marketplace」**：directory marketplace 的 `source.path` / `installLocation` 原分别指向 `.claude-plugin` 子目录和一个**从未填充的** `marketplaces/<name>` 空目录，Claude Code 据此读不到清单。改为两者都指向 `cachePath`（marketplace 根，含 `.claude-plugin/marketplace.json`）。
- **`[stdin]:1` SessionStart hook 报错**：`hooks.json` 把命令拆成 `command` + `args`，Claude Code 的 hook schema 只认**单字符串 `command`**、忽略 `args` → 只执行了裸 `node`，把会话 JSON 当 JS 源读而报错。改成单串 `node "${CLAUDE_PLUGIN_ROOT}/bin/launcher.cjs" <Event>`。
- **Linux 上 `Permission denied`**：发布的 `dist/install.cjs` 不可执行，npx 经 `.bin` 符号链接 + shebang 执行时被拒。打包后强制 `0o755`。
- **Windows 发布丢 `+x` 位**：Windows `npm pack` 不保留可执行位（POSIX mode 在 Windows 是假的，`chmodSync` 无效）。新增 `scripts/fix-tarball-mode.py`（stdlib tarfile），打包后直接改 tar 条目为 `0o755` 再 `npm publish <tgz>`（发预打包 tarball，不再 `prepublishOnly` 重新打包）。

### 验证

目标机 Kali（Claude Code 2.1.123、node v24.15.0）端到端实测：`npx shine-code-submit@0.2.4 install` → `claude plugin list` 显示 ✔ enabled、SessionStart hook 退出码 0、daemon 日志 `ingest http SessionStart`。

## 0.2.3 — 2026-07-07（已被 0.2.4 取代）

含 marketplace 路径修复，但发布时漏了 `install.cjs` 可执行位与 `hooks.json` 单串 command 两处修复。**请直接用 0.2.4。**

## 0.2.0 ~ 0.2.2 — 2026-07

npm 分发的初版，安装链路存在上述自定位 / 加载 / hook 多个 bug，不可用。保留仅为版本号连续。

---

## 0.1.x

早期的「方案 C 源码直跑 + 自建 Gitea marketplace」分发形态（`/plugin marketplace add`），不含 npm 安装器。详见 README「分发方案」一节与 git 历史。
