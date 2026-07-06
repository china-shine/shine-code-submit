# Shine Code Submit

Claude Code Hook → 本地常驻 Daemon 的状态/持久化底座。Hook 只做「采集 + 落盘 + 转发」立即退出，重活交给后台 Daemon 异步处理，不拖慢 Claude Code。详见 [`设计文档.md`](./设计文档.md)。

以 **Claude Code Plugin** 形式分发——`/plugin install` 一键安装，跨平台（Windows/macOS/Linux × x64/arm64）。

claude --resume 964154b8-3a68-4b4d-ae43-10205ff50978
## 架构

```
Claude Code ──事件──▶ node launcher.js ──spawn──▶ hook(短命) ──┬── POST(热路径) ──▶ Daemon(常驻)
                                                                └── spool 落盘 ──▶  (回捞兜底)
                                                                                      ├── SQLite(幂等)
                                                                                      ├── WS 推送
                                                                                      └── 查看页 /ui
```

可靠性：异步 ≠ 可丢，但允许重放。Hook 先原子落盘 spool 再转发；Daemon 崩溃自愈；事件不丢、处理幂等。

### hook / daemon / cli 分工

| 二进制 | 生命周期 | 职责 |
|---|---|---|
| **hook** | 短命（每次事件 spawn 后立即退出） | Claude Code 经 hooks.json 调它；采集事件 → POST 给 daemon（热路径）+ spool 落盘（兜底）→ 退出。绝不拖慢 Claude Code |
| **daemon** | 常驻后台（首次被 hook 拉起，自愈） | 收事件存 SQLite（幂等去重）、WebSocket 推送查看页、提供 HTTP API、内嵌并服务查看页 UI |
| **cli** | 按需（用户手动跑） | 管理命令：`status` / `start` / `stop` / `restart` / `ui`。读 pid 文件取 token → 调 daemon API |

三者同目录，hook 用 `process.execPath` 定位 daemon，零配置。

### 二进制为何这么大

每个二进制 ~94MB（Windows x64），`bin/` 共 ~1.5GB（6 平台）。`bun build --compile` 把**整个 Bun 运行时**（JavaScriptCore + sqlite + 系统 API）静态链入每个二进制——源码本身很小（hook 9KB / daemon 33KB / cli 6KB），运行时占 ~90MB 且三个二进制各自独立含一份、不共享。这是 `--compile` 的固有代价，减重只能换方案 B（Release 下载）或 C（源码跑，运行时全局只装一份）。

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

本仓库既是 plugin 又兼作 marketplace，采用**方案 C（源码直跑）**——仓库只含源码、无二进制，因此**用户机器需先装 [Bun](https://bun.sh) 1.3+**。

### 前置：安装 Bun

机器上已有 node/npm 的话最省事（国内可复用 npm mirror）：

```
npm install -g bun
```

或用官方脚本——Windows（PowerShell）：

```
powershell -c "irm bun.sh/install.ps1 | iex"
```

macOS / Linux：

```
curl -fsSL https://bun.sh/install | bash
```

装完重开终端，`bun --version` 确认可用。

### 从 Gitea 安装

```
/plugin marketplace add  http://8.130.168.121:9001/AI/shine-code-submit.git
/plugin install shine-code-submit@shine-code-submit
```

clone 后无二进制；首次 hook 事件时 `bin/launcher.js`（node）自动 `bun run src/hook/main.ts`，daemon 同理 `bun run src/daemon/main.ts`。

> ⚠️ Windows 系统代理会让 git 连不上 localhost。先 `setx NO_PROXY "localhost,127.0.0.1"` 并**重启 Claude Code**，再 `marketplace add`。

### 从本地目录安装（开发自测）

```
/plugin marketplace add <本仓库本地路径>
/plugin install shine-code-submit@shine-code-submit
```

直接读本机源码，改完即时生效（无需 build）。

---

装完**开新会话**即生效。查看页（可选）：`bun run src/cli/main.ts ui`。

## 分发方案：三种取舍

本项目支持三种分发方案（A、B 为二进制，C 为源码直跑）：

### 方案 A：二进制 commit 进 `bin/`（备选）

18 个二进制 commit 进 `bin/<plat>-<arch>/`，经 Git LFS 纳管。clone/安装即自带，launcher 直接 spawn 本地 hook，**装即用、无需联网**。

- ✅ 安装最简单（装即用，无首次下载）
- ✅ 本地/自建 git 仓库无 LFS 配额限制
- ⚠️ GitHub 公开时占 LFS 配额（免费约 1GB 存储 + 1GB/月流量；776MB 二进制几人 clone 即超额）
- ⚠️ clone 需拉 LFS 对象（首次稍慢）

### 方案 B：GitHub Releases 下载（仓库更小，备选）

二进制移出 git，作为 GitHub Release 资产。plugin 仓库只留源码 + `launcher.js`（几 MB，clone 快、零 LFS）。launcher 首次运行（SessionStart）按平台从 Release 下载 hook/cli/daemon 到 `%LOCALAPPDATA%/shine-code-submit/bin/<plat>-<arch>/`。

- ✅ 仓库小、clone 快、GitHub 无 LFS 配额压力
- ⚠️ 首次安装需联网下载约 300MB（SessionStart 的 `timeout` 调到 300s）
- ⚠️ 需额外发 Release（`gh release create`）+ launcher 下载自举逻辑

> 切换到方案 B 的实现见 git 历史 commit `fc30665`（launcher 下载自举 + `scripts/release.sh`）。
claude --resume 61a9beba-9bc9-4407-a41e-270e3d2efed3

### 方案 C：源码直跑（**本仓库采用** ✅，需 Bun）

不产出/不分发二进制，launcher 与 daemon 直接用 `bun run src/...` 跑源码。plugin 仓库只留源码 + `launcher.js`（几 MB，无 LFS、无 Release）。

- ✅ 仓库最小、零 LFS 配额、无需发 Release
- ✅ 改源码即时生效（无 build/commit 二进制步骤）
- ⚠️ 用户机器须装 Bun 1.3+（开发者向，非通用）
- ⚠️ hook/daemon 启动比二进制慢几百 ms（bun run 源码）

> 实施需：`bin/launcher.js` 与 `src/shared/daemonctl.ts` 加「二进制优先、否则 `bun run src/...`」分支；`bin/<plat>-<arch>/` 移除并加入 `.gitignore`；cli 用 `bun run src/cli/main.ts`。

## 开发（贡献者）

依赖 [Bun](https://bun.sh) 1.3+：

```bash
bun install
bun run build          # 产本机平台到 bin/<本机plat>-<arch>/（开发自测）
bun run build:all      # 6 平台交叉编译到 bin/（方案 A 需 commit 这些）
bun run typecheck
```

方案 A 下，`build:all` 产出的 18 个二进制需 `git add bin/` commit（LFS 自动纳管）。本仓库 `.claude/settings.json` 指向 `bin/windows-x64/hook.exe`，本机 build 后即可自测。Daemon 默认由同目录二进制拉起；开发期可用 env 覆盖跑 `bun run`。

## 目录

```
.claude-plugin/  plugin.json、marketplace.json（plugin 元信息 + 自托管市场）
hooks/           hooks.json（plugin hook 注册，exec form 调 node launcher）
bin/             launcher.js + <plat>-<arch>/{hook,cli,daemon}（编译产物，commit 入库，Git LFS）
src/             shared/ daemon/ hook/ cli/（三端共用源码）
ui/              查看页（原生 JS，编译期嵌入 daemon 二进制）
scripts/         build.ts
```

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `SHINE_CODE_SUBMIT_DAEMON_CMD` | 拉起 daemon 的完整命令（开发期，如 `bun run src/daemon/main.ts`） | 同目录 daemon 二进制 |
| `SHINE_CODE_SUBMIT_DAEMON` | 仅 `bun run` 入口路径 | 无 |
| `SHINE_CODE_SUBMIT_DEBUG` | 开启 daemon DEBUG 日志 | 无 |

## 数据位置

`%LOCALAPPDATA%/shine-code-submit/`：

```
daemon.pid        pid/port/token/startedAt
spool/*.json      待消费事件（每事件一文件，原子写）
log/daemon.log    日志（按大小轮转）
db/events.sqlite  事件库（按 cwd 隔离，幂等去重）
```

二进制在 plugin 安装目录的 `bin/<plat>-<arch>/`（不在数据目录）。

> 旧版本（livesetting）的数据目录 `%LOCALAPPDATA%/livesetting/` 不会自动迁移，可手动删除。

## 关键设计点

- **目录式 spool + 原子 rename**：每事件一文件，规避多进程并发 append 损坏。
- **幂等**：`(sessionId, eventId)` 唯一约束 + `INSERT OR IGNORE`，热路径与回捞共享，允许重放。
- **热路径优先**：直接 POST，连接失败才探测/拉起（健康路径单次往返）。
- **认自己人**：`/api/health` 返回 `service` 字段，Hook 校验后才认端口归属。
- **只绑 127.0.0.1 + token**：健康端点外都鉴权。
- **自启动 + 自愈**：任意事件故障路径都能拉起；重复实例启动时自检退出，crash 只删属于自己的 pid。
- **跨平台分发（方案 A）**：plugin 的 hooks.json 静态、无平台变量，靠 `bin/launcher.js` 按 `process.platform/arch` 选 `bin/<plat>-<arch>/` 里的二进制；hook/cli/daemon 同目录，hook 用 `process.execPath` 定位 daemon，零额外配置、装即用。
