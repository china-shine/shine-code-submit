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
| **cli** | 按需（用户手动跑） | 管理命令：`status` / `start` / `stop` / `restart` / `ui`。读 pid 文件取 token → 调 daemon API |

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
/plugin marketplace add  renguifeng/shine-code-submit
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

## 目录

```
.claude-plugin/  plugin.json、marketplace.json（plugin 元信息 + 自托管市场）
hooks/           hooks.json（plugin hook 注册，command 调 node launcher.cjs）
bin/             launcher.cjs（hook 分发器）；<plat>-<arch>/ 本机编译产物（gitignored，不入库）
src/             shared/ daemon/ hook/ cli/ install/（多端共用源码）
ui/              查看页（React/TSX，由 daemon 内嵌 HTTP 服务）
dist/            install.cjs（npm 发布产物，gitignored）
scripts/         build.ts、build-install.ts、publish.sh、fix-tarball-mode.py
```

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `SHINE_CODE_SUBMIT_HOST` | daemon 监听地址。默认 `0.0.0.0`（绑所有网卡，局域网可访问）；仅本机回环用时设 `127.0.0.1` | `0.0.0.0` |
| `SHINE_CODE_SUBMIT_DAEMON_CMD` | 拉起 daemon 的完整命令（开发期覆盖） | `bun run src/daemon/main.ts` |
| `SHINE_CODE_SUBMIT_DAEMON` | 仅 `bun run` 入口路径 | `src/daemon/main.ts` |
| `SHINE_CODE_SUBMIT_DEBUG` | 开启 daemon DEBUG 日志 | 无 |

## 数据位置

`%LOCALAPPDATA%/shine-code-submit/`（Windows）或 `~/.local/share/shine-code-submit/`（macOS/Linux）：

```
daemon.pid        pid/port/token/startedAt
spool/*.json      待消费事件（每事件一文件，原子写）
log/daemon.log    日志（按大小轮转）
db/events.sqlite  事件库（按 cwd 隔离，幂等去重）
```

## 关键设计点

- **目录式 spool + 原子 rename**：每事件一文件，规避多进程并发 append 损坏。
- **幂等**：`(sessionId, eventId)` 唯一约束 + `INSERT OR IGNORE`，热路径与回捞共享，允许重放。
- **热路径优先**：直接 POST，连接失败才探测/拉起（健康路径单次往返）。
- **认自己人**：`/api/health` 返回 `service` 字段，Hook 校验后才认端口归属。
- **默认绑 0.0.0.0 + token**：健康端点外都鉴权；默认暴露给局域网（方便其他设备访问），仅本机回环用时设 `SHINE_CODE_SUBMIT_HOST=127.0.0.1`（见「局域网访问」）。
- **监听/连接地址分离**：daemon 监听用 `LISTEN_HOST`（默认 0.0.0.0，env 可配）；hook POST / cli / 探活 连接 daemon 固定走 `127.0.0.1` 回环（daemon 即使绑 0.0.0.0 也含回环），最快最稳。
- **打印链接用真实网卡 IP**：`PUBLIC_BASE_URL` 取第一个非虚拟网卡的 IPv4（跳过 vEthernet/VMware/docker），局域网设备可直接访问；本机打开浏览器则用 `localhost`（WSL2 转发友好）。
- **自启动 + 自愈**：任意事件故障路径都能拉起；重复实例启动时自检退出，crash 只删属于自己的 pid。
- **hook 永不阻断**：launcher 与 hook 退出码恒 0，Bun 缺失时自动安装或静默跳过，绝不影响 Claude Code 主进程。
