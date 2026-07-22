# Shine Code Submit

Claude Code Hook → 本地常驻 Daemon 的状态/持久化底座。Hook 只做「采集 + 落盘 + 转发」立即退出，重活交给后台 Daemon 异步处理，不拖慢 Claude Code。详见 [`设计文档.md`](./设计文档.md)。更新日志见 [`CHANGELOG.md`](./CHANGELOG.md)。

以 **Claude Code Plugin** 形式分发——`npx shine-code-submit install` 一键安装（也支持 `/plugin marketplace add` 从 GitHub 装），跨平台（Windows/macOS/Linux × x64/arm64）。

## 架构

```
Claude Code ──事件──▶ node launcher.cjs ──spawn──▶ hook(短命) ──┬── POST(热路径) ──▶ Daemon(常驻)
                                                                └── spool 落盘 ──▶  (回捞兜底)
                                                                                      ├── SQLite(幂等)
                                                                                      ├── WS 推送
                                                                                      └── 查看页 /ui
```

可靠性：异步 ≠ 可丢，但允许重放。Hook 先原子落盘 spool 再转发；Daemon 崩溃自愈；事件不丢、处理幂等。

### hook / daemon / cli 分工

| 组件 | 生命周期 | 职责 |
|---|---|---|
| **hook** | 短命（每次事件 spawn 后立即退出） | Claude Code 经 hooks.json 调它；采集事件 → POST 给 daemon（热路径）+ spool 落盘（兜底）→ 退出。绝不拖慢 Claude Code |
| **daemon** | 常驻后台（首次被 hook 拉起，自愈） | 收事件存 SQLite（幂等去重）、WebSocket 推送查看页、提供 HTTP API、内嵌并服务查看页 UI |
| **cli** | 按需（用户手动跑） | 管理命令：`status` / `start` / `stop` / `restart` / `ui` / `update`。读 pid 文件取 token → 调 daemon API；`update` 查 npm 最新版后台升级 |

三者共享 `src/`；hook/cli 跑在 Bun 下，用 `process.execPath`（= bun）执行 `bun run src/daemon/main.ts` 拉起 daemon，零配置。

> **源码直跑，不分发二进制**——仓库只含源码，launcher 与 daemon 直接 `bun run src/...`。仓库小、改源码即时生效；代价是用户机器要有 Bun，装不上时安装器 / launcher 会自动装（见下）。

## Hook 事件覆盖

Claude Code 共 9 个 hook 事件（[官方清单](https://docs.claude.com/en/docs/claude-code/hooks)）。本插件注册其中 7 个**只读观测**事件；所有 hook 退出码恒 0，绝不阻断或改写 Claude Code 主进程。

| 事件 | 注册 | 触发时机 |
| --- | :---: | --- |
| `SessionStart` | ✅ | 会话开始 / resume / clear / compact（兼做 daemon 首次拉起） |
| `UserPromptSubmit` | ✅ | 用户提交提示词前 |
| `PostToolUse` | ✅ | 工具调用完成后 |
| `Stop` | ✅ | 主 agent 结束响应 |
| `SubagentStop` | ✅ | 子 agent（Task 工具）结束响应 |
| `PreCompact` | ✅ | 上下文压缩前（手动 `/compact` 或自动） |
| `SessionEnd` | ✅ | 会话结束（clear / logout / exit） |
| `PreToolUse` | ❌ | 工具调用前——**故意不启用**：其 exit2/JSON 会阻断或改写工具调用，与「Hook 不影响主进程」冲突；需拦截时再单独设计同步返回逻辑 |
| `Notification` | ❌ | 权限请求 / 闲置通知——噪音大、观测价值低，默认不收 |

> `SessionResume` 在部分资料里被列为独立事件；官方文档里 resume 是 `SessionStart` 的一个 `source` matcher，非独立事件。

## 安装（用户）

两种方式，任选其一。

### 方式一（推荐）：npx 一键安装

```
npx shine-code-submit install
```

> 国内 npm 若默认走镜像（npmmirror），新版同步有延迟；拉不到最新版时加 `--registry=https://registry.npmjs.org/` 指官方源。

一条命令完成：

1. 自动检测并安装运行时 **Bun**（1.1+，国内镜像优先 `npm i -g bun`，否则走官方脚本）；
2. 部署 plugin 到 `~/.claude/plugins/cache/shine-code-submit/shine-code-submit/<version>/`；
3. `bun install` 装运行时依赖（marked / react / react-dom）；
4. 注册 marketplace + plugin + 启用（写 `known_marketplaces.json` / `installed_plugins.json` / `settings.json` 三处 JSON）；
5. 拉起 daemon、打印 Dashboard 链接。

装完**重启 Claude Code**，`/plugin` 列表会显示 `shine-code-submit`（✔ enabled）；开新会话即触发 SessionStart hook，事件出现在 Dashboard。

卸载：`npx shine-code-submit uninstall`（⚠️ 不要 `sudo` —— sudo 没有 nvm 的 PATH，会 `npx: command not found`）。

### 方式二：`/plugin marketplace add`（从 GitHub）

源码直跑，需要 Bun 运行时——**没装也行**：首次 SessionStart 时 `launcher.cjs` 会自动装（`npm i -g bun`，失败回退官方脚本，约 10-30s；SessionStart 已配 200s 超时兜底，进度见 `~/.local/share/shine-code-submit/log/bun-install.log`）。想首次更快可先手装 `npm install -g bun`，或官方脚本——Windows `powershell -c "irm bun.sh/install.ps1 | iex"`，macOS/Linux `curl -fsSL https://bun.sh/install | bash`。

**从 GitHub：**

```
/plugin marketplace add  china-shine/shine-code-submit
/plugin install shine-code-submit@shine-code-submit
```

clone 后只有源码；首次 hook 事件时 `bin/launcher.cjs`（node）自动 `bun run src/hook/main.ts`，daemon 同理 `bun run src/daemon/main.ts`。

> 需机器能访问 github.com（国内通常要走代理）；`marketplace add` 走 git，代理配好即可。

**从本地目录（开发自测）：**

```
/plugin marketplace add <本仓库本地路径>
/plugin install shine-code-submit@shine-code-submit
```

直接读本机源码，改完即时生效（无需 build）。

---

## 查看页（Dashboard）

装完**开新会话**即生效。两种打开方式：

- **自动**：每次真·新开会话（`source=startup`，非 `resume/clear/compact`），hook 会在会话顶部打印一行 Dashboard 链接（走 Claude Code 的 `systemMessage` 机制，直接显示给你；裸 stdout 只注入 assistant 当 context，用户不可见）。复制到浏览器即开。
- **手动**：`bun run src/cli/main.ts ui` —— 打印带 token 的链接并尝试打开浏览器。

> daemon 没起来也不报错：SessionStart hook 会先拉起 daemon 再读 token 打印；万一拉起失败则静默跳过（退出码恒 0，绝不阻断 Claude Code）。

### 局域网访问（其他设备看 Dashboard）

daemon 默认绑 `0.0.0.0`（所有网卡），打印的 Dashboard 链接自动用**第一个真实网卡的局域网 IP**（`getPrimaryIpv4` 跳过 vEthernet/VMware/docker 等虚拟网卡）。开新会话时链接形如 `http://192.168.x.x:36666/ui?t=...`，手机/平板/局域网其他设备直接能用。仅本机回环用时设 `SHINE_CODE_SUBMIT_HOST=127.0.0.1` 再 restart daemon。

端口对外可达性：

- **裸机 / Windows 原生跑 daemon**：绑 `0.0.0.0` 即对局域网可见，放行防火墙 36666 入站即可。
- **WSL2**：daemon 在 NAT 后，链接取到的是 WSL eth0 的 `172.x`（局域网外不可达）；要让局域网设备真访问到，需 `networkingMode=mirrored`（`.wslconfig`，推荐）或 `netsh portproxy` 端口转发。

> ⚠️ 绑非回环后，`token`（UI 链接 `?t=` 里明文）成为数据接口唯一防线。仅可信网络下如此配，勿外泄带 token 的链接。

## 开发（贡献者）

依赖 [Bun](https://bun.sh) 1.3+：

```bash
bun install
bun run typecheck            # tsc --noEmit
bun run build:install        # 编译 install CLI → dist/install.cjs（npm bin 入口）
bun run build                # 编译本机平台 daemon/hook/cli 到 bin/<plat>-<arch>/（本地自测）
```

- `dist/install.cjs`：`npx shine-code-submit` 的入口，发布到 npm。`scripts/build-install.ts` 把 `src/install/*` 打成单文件 cjs bundle。
- `bin/<plat>-<arch>/`：`bun build --compile` 产出的**本机**二进制，开发自测用、**gitignored、不入库、不发布**。launcher 优先用它、没有则 `bun run src/...`，所以不 build 也能跑。
- 发版到 npm：`bash scripts/publish.sh`（build → `npm pack` → `fix-tarball-mode.py` 修 `+x` → `npm publish <tgz>`）。详见 [`CHANGELOG.md`](./CHANGELOG.md)。

### 源码调试（直接 bun run，不经插件 / exe）

调试 daemon / hook / UI 的首选：绕开插件机制与 `bin/launcher.cjs`，全程 `bun run` 源码，改 `.ts` 即时生效、不 build 任何二进制。

> 不用 `/plugin install` 本地目录的原因：`launcher.cjs` 见 `bin/<plat>-<arch>/hook.exe` 存在就优先 spawn 二进制（固化旧版），插件路径还可能复制到 cache；下法彻底绕开。

**① 起 daemon**（源码模式，占住 36666）：

```bash
bun run src/daemon/main.ts
```

Dashboard：`http://localhost:36666/ui?t=<token>`，token 在 `%LOCALAPPDATA%/shine-code-submit/daemon.pid`，或 `bun run src/cli/main.ts ui` 打印带 token 链接。已有个同源 daemon 在跑时会自检复用、不重复启动（`isOursAlive`）。

**② Claude Code 事件走源码 hook**——项目 `.claude/settings.local.json`（已 gitignore，本地专用）把各事件 command 直指源码：

```json
{
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "bun run \"<仓库绝对路径>/src/hook/main.ts\" PostToolUse" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun run \"<仓库绝对路径>/src/hook/main.ts\" SessionStart" }] }]
  }
}
```

（`UserPromptSubmit / Stop / SubagentStop / PreCompact / SessionEnd` 同理。）**重启 Claude Code** 加载后，本项目事件直接跑源码 hook，不碰 `bin/*.exe`。

**③ 改代码生效**：

| 改动 | 操作 |
|---|---|
| `src/daemon/*.ts` | 重启 daemon：`powershell -c "Stop-Process -Id <pid> -Force"`（pid 见 pid 文件）后重跑① |
| `src/hook/*.ts` | 下次 hook 触发自动用新源码，无需重启 |
| `ui/*.tsx` | `bun run build:ui` 重新生成 `src/daemon/ui-assets.ts` → 重启 daemon |

`npm run build:ui`（`scripts/build-ui.ts`）只把 `ui/*` bundle 成字符串嵌入 `ui-assets.ts`、**不 build exe**，与 `build.ts` 的 ui 段同口径。源码 hook 每次事件 `spawn bun`，比二进制慢、`PostToolUse` 高频事件有几百 ms 延迟，调试完删 `settings.local.json` 即恢复。

### 分级加载 + 缓存（架构概览）

本地 dashboard 数据加载分三级懒加载，后端 4 层缓存兜底（2026-07-22 重构）：

- **前端三级表格钻取**：L1 项目表（`/api/projects` 分页）→ L2 session 表（`/api/sessions?cwd=` 分页）→ L3 聊天（`/api/transcript`，已是懒加载）。会话/报表模块各用 `PagedTable`（服务端分页 + 序号 + 骨架行 + 刷新按钮）。
- **后端 4 层缓存**（稳态全命中 → 秒回）：① `scanSessions`（10s TTL + SessionStart 主动失效）② `getSessionInfo`（mtime 内容键，token/title/cwd/activeMs 一次算）③ `git`（per-cwd 5min）④ `getSessionLines`（lastActive 键）。
- **预热**：daemon 启动 500ms 后台扫一次填缓存（避开初始 SessionStart），代价是 1.5s 同步扫描短暂阻塞 hook（走 spool 兜底，事件不丢）。预热只帮"daemon 起 10s 内打开"（scanCache 10s TTL）。
- **首次冷扫兜底**：进度条（`LoadingBar`）+ 骨架行，加载完消失。
- **彻底消除冷扫（远期，未做）**：transcript 扫描结果持久化 sqlite，启动读 DB + 只扫新/活跃。

token 口径对齐 ccusage（静止 session 逐字段全等）。详见 `src/daemon/claude-scan.ts`、`aggregate.ts`、`server.ts` 注释。

## 目录

```
.claude-plugin/  plugin.json、marketplace.json（plugin 元信息 + 自托管市场）
hooks/           hooks.json（plugin hook 注册，command 调 node launcher.cjs）
bin/             launcher.cjs（hook 分发器）；<plat>-<arch>/ 本机编译产物（gitignored，不入库）
src/             shared/ daemon/ hook/ cli/ install/（多端共用源码）
ui/              查看页（React/TSX，由 daemon 内嵌 HTTP 服务）
dist/            install.cjs（npm 发布产物，gitignored）
scripts/         build.ts、build-install.ts、publish.sh、fix-tarball-mode.py、verify-transcript-parity.ts（transcript 对齐校验）
tokenserver/     报表上报接收服务（独立子项目,bun+sqlite+React,可打包 Linux 二进制;见 tokenserver/README.md）
```

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `SHINE_CODE_SUBMIT_HOST` | daemon 监听地址。默认 `0.0.0.0`（绑所有网卡，局域网可访问）；仅本机回环用时设 `127.0.0.1` | `0.0.0.0` |
| `SHINE_CODE_SUBMIT_DAEMON_CMD` | 拉起 daemon 的完整命令（开发期覆盖）。未设时 fallback：优先用同目录 daemon 二进制，否则 `bun run` 源码 | `bun run src/daemon/main.ts` |
| `SHINE_CODE_SUBMIT_DAEMON` | 仅 `bun run` 入口路径（未设时同上 fallback） | `src/daemon/main.ts` |
| `SHINE_CODE_SUBMIT_DEBUG` | 开启 daemon DEBUG 日志 | 无 |

## 数据位置

`%LOCALAPPDATA%/shine-code-submit/`（Windows）或 `~/.local/share/shine-code-submit/`（macOS/Linux）：

```
daemon.pid        pid/port/token/startedAt
spool/*.json      待消费事件（每事件一文件，原子写）
log/daemon.log    日志（按大小轮转）
db/events.sqlite  事件库（按 cwd 隔离，幂等去重）
settings.json     上报与更新配置（reportUrl/reportIntervalMin,默认 http://47.98.221.20:36667/api/report、10 分钟;autoUpdate/autoUpdateIntervalMin,默认开/60 分钟）
```

## 报表上报

daemon 默认每 10 分钟（`reportIntervalMin`）或手动（Dashboard「上报」按钮）把会话/token 聚合报表 POST 到 `reportUrl`（默认 `http://47.98.221.20:36667/api/report`，可在「设置」页改）。接收端 [`tokenserver/`](./tokenserver/README.md) 按 **用户 → 项目 → token** 三级展示。

**上报身份 = `git config user.name`**：采集不到（机器未配 `user.name`，如部分 CI/容器/新机）时**跳过本次上报**，不再以「未知用户」上传；手动上报按钮会提示「已跳过：未采集到 git user.name,跳过上报(无上报身份)」。配置 `git config --global user.name <名字>` 后即恢复上报。

## Token 统计逻辑（与 [ccusage](https://github.com/ccusage/ccusage) 对齐）

报表和会话树的 token 数据**直接扫描 Claude Code transcript**（不依赖 hook 是否抓到），算法与 `ccusage claude session` 一致——同一份 transcript 产出的四个字段逐字段相等。

**数据源**：只读 `<配置目录>/projects/**/*.jsonl`（**不碰 `.claude` 其他内容**：settings / 历史 / 插件 / 遥测等一律不读）。配置目录解析顺序：`CLAUDE_CONFIG_DIR`（逗号分隔）→ `$XDG_CONFIG_HOME/claude` → `~/.claude`（等价 ccusage `claude_paths`）。

**逐行处理**（对齐 ccusage `read_usage_file` 的门）：

1. 跳过无 `"usage":{` 的行；
2. 跳过关键字段为 `null` 的行（`id / cwd / model / speed / costUSD / version / sessionId / requestId / isApiErrorMessage / cache_read_input_tokens / cache_creation_input_tokens`）；
3. JSON 解析失败 / 时间戳非严格 ISO8601 / `version` 非 semver / 各 id 为空 → 丢弃。

**四个 token 字段**（取自 `message.usage`）：

```
input         = input_tokens
output        = output_tokens
cacheCreation = cache_creation.ephemeral_5m_input_tokens + cache_creation.ephemeral_1h_input_tokens
               （无 5m/1h 细分时回退 cache_creation_input_tokens）
cacheRead     = cache_read_input_tokens
```

**去重**：按 `message.id + requestId` 去重（含子代理 sidechain 重放兜底）；同一 key 多条时的取舍顺序：**非 sidechain 优先 → total 更大 → 带 speed**。

**Session 归并**：父 transcript `projects/<project>/<session>.jsonl` 与同目录 `<session>/subagents/*.jsonl`（子代理）合并为**一个 session**，跨文件全局去重后求和。

**显示口径 = 原始总量**（= ccusage `totalTokens`）：

```
rawTotal = input + output + cacheCreation + cacheRead
```

> 1.0.12 之前用计费口径 `realInput = input + cacheCreation×1.25 + cacheRead×0.1`（缓存读打 0.1 折），现改为原始总量 `rawTotal`，与 ccusage 完全一致。

**聚合**：按项目（cwd，hook 真实路径优先、无则解码项目名）汇总各 session；同名项目用「父目录/项目名」消歧；全局 token 总量 = 所有 session 之和。`0-token` 的空 transcript 不计入 session 数（对齐 ccusage）。

实现：`src/daemon/transcript.ts`（逐行解析/校验/去重）、`src/daemon/claude-scan.ts`（扫描 + session 归并）、`src/daemon/server.ts`（报表/会话聚合）。

## 关键设计点

- **目录式 spool + 原子 rename**：每事件一文件，规避多进程并发 append 损坏。
- **幂等**：`(sessionId, eventId)` 唯一约束 + `INSERT OR IGNORE`，热路径与回捞共享，允许重放。
- **热路径优先**：直接 POST，连接失败才探测/拉起（健康路径单次往返）。
- **认自己人**：`/api/health` 返回 `service` 字段，Hook 校验后才认端口归属。
- **默认绑 0.0.0.0 + token**：数据接口（`/api/*` 除 `/api/health`）均鉴权，静态页（`/`、`/ui`）与健康端点开放；默认暴露给局域网（方便其他设备访问），仅本机回环用时设 `SHINE_CODE_SUBMIT_HOST=127.0.0.1`（见「局域网访问」）。
- **监听/连接地址分离**：daemon 监听用 `LISTEN_HOST`（默认 0.0.0.0，env 可配）；hook POST / cli / 探活 连接 daemon 固定走 `127.0.0.1` 回环（daemon 即使绑 0.0.0.0 也含回环），最快最稳。
- **打印链接用真实网卡 IP**：`PUBLIC_BASE_URL` 取第一个非虚拟网卡的 IPv4（跳过 vEthernet/VMware/docker），显示与打开浏览器共用同一地址（本机、局域网通用）；无非回环网卡时才回退 `localhost`。
- **自动更新（主动外联 npm）**：`autoUpdate` 默认开，daemon 启动时 + 每 `autoUpdateIntervalMin`（默认 60 分钟）查 `registry.npmjs.org` 最新版，有新版后台 spawn `npx shine-code-submit install` 升级。介意外联可在 settings.json 设 `autoUpdate:false`，或 CLI `update` 手动触发。
- **自启动 + 自愈**：任意事件故障路径都能拉起；重复实例启动时自检退出，crash 只删属于自己的 pid。
- **hook 永不阻断**：launcher 与 hook 退出码恒 0，Bun 缺失时自动安装或静默跳过，绝不影响 Claude Code 主进程。
