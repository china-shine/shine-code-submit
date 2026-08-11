# Shine Worklog

Claude Code Hook → 本地常驻 Daemon 的状态/持久化底座。Hook 只做「采集 + 落盘 + 转发」立即退出，重活交给后台 Daemon 异步处理，不拖慢 Claude Code。详见 [`设计文档.md`](./设计文档.md)。更新日志见 [`CHANGELOG.md`](./CHANGELOG.md)。

以 **Claude Code Plugin** 形式分发——`npx shine-worklog install` 一键安装（也支持 `/plugin marketplace add` 从 GitHub 装），跨平台（Windows/macOS/Linux × x64/arm64）。

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
| **hook** | 短命（每次事件 spawn 后立即退出） | Claude Code 经 hooks.json 调它；采集事件 → spool 落盘（兜底）+ POST 给 daemon（热路径）→ 退出。绝不拖慢 Claude Code |
| **daemon** | 常驻后台（首次被 hook 拉起，自愈） | 收事件存 SQLite（幂等去重）、WebSocket 推送查看页、提供 HTTP API、内嵌并服务查看页 UI |
| **cli** | 按需（用户手动跑） | 管理命令：`status` / `start` / `stop` / `restart` / `ui` / `update`。读 pid 文件取 token → 调 daemon API；`update` 查 npm 最新版后台升级 |

三者共享 `src/`；hook/cli 跑在 Bun 下，用 `process.execPath`（= bun）执行 `bun run src/daemon/main.ts` 拉起 daemon，零配置。

> **源码直跑，不分发二进制**——仓库只含源码，launcher 与 daemon 直接 `bun run src/...`。仓库小、改源码即时生效；代价是用户机器要有 Bun，装不上时安装器 / launcher 会自动装（见下）。

## Hook 事件覆盖

Claude Code 共 9 个 hook 事件（[官方清单](https://docs.claude.com/en/docs/claude-code/hooks)）。本插件注册其中 7 个事件（**以只读观测为主**；SessionStart/UserPromptSubmit 额外注入 additionalContext 辅助禅道工时闭环）；所有 hook 退出码恒 0，绝不阻断或改写 Claude Code 主进程。

| 事件 | 注册 | 触发时机 + 额外职责 |
| --- | :---: | --- |
| `SessionStart` | ✅ | 会话开始/resume/clear/compact；兼做 daemon 首次拉起 + **注入 CLAUDE.md 工时规则**（additionalContext，教 AI 顺手记） |
| `UserPromptSubmit` | ✅ | 用户提交提示词前；**每轮注入提示词**「本轮有代码改动,响应结束前记 note」（feedback，无 block）；task 不确定记 `-1` |
| `PostToolUse` | ✅ | 工具调用完成后（观测） |
| `Stop` | ✅ | 主 agent 结束响应；**forkZenCollect**：detached 采集 session 到 sessions.json |
| `SubagentStop` | ✅ | 子 agent（Task 工具）结束响应；同 Stop（forkZenCollect 采集） |
| `PreCompact` | ✅ | 上下文压缩前（手动 `/compact` 或自动，观测） |
| `SessionEnd` | ✅ | 会话结束（clear / logout / exit，观测） |
| `PreToolUse` | ❌ | 工具调用前——**故意不启用**：其 exit2/JSON 会阻断或改写工具调用，与「Hook 不影响主进程」冲突 |
| `Notification` | ❌ | 权限请求 / 闲置通知——噪音大、观测价值低，默认不收 |

> `SessionResume` 在部分资料里被列为独立事件；官方文档里 resume 是 `SessionStart` 的一个 `source` matcher，非独立事件。

### 禅道工时闭环（skills：自动攒 + 秒级提交）

工时从"开发中自动攒"到"`/report` 秒级提交"的闭环：
- **SessionStart** 注入 CLAUDE.md「工时顺手记」规则 → AI 知道一轮对话完成时要 note，task 不确定记 `-1`（不跳过、不问）
- **UserPromptSubmit** 每轮注入提示词「本轮有代码改动,响应结束前记 note」（feedback，无 block）
- **`/prepare`**：手动批量读 transcript 生成 work+task（补漏）
- **`/report`**：读 summary 缓存 → AI 综合成 ≤3 总结 → 提交禅道（读缓存→总结→提交，跳过最耗时的 AI 填空）。task=-1 的 note 标 `unmatched`，先停下集中匹配候选任务，匹配好后和 task>0 的**一次统一提交**
- **`/daily` `/weekly` `/amend`**：日报 / 周报 / 修正最后一次提交
- **`/mark`**：配置 **AI 提交标识**（开关 + 文案）——提交禅道工时在 work 末尾追加一行标识（默认「本次内容由AI填报」），`/daily` `/weekly` 据此对账统计「AI 代报 N h」；dashboard「设置 → AI 提交标识」区块配同一处（`settings.json` 的 `aiSubmitMark`）
- **`/mappings`**：查看 / 维护仓库→禅道项目映射缓存（`mappings.json`，`/report` commit 时自动学习）
- **`/setup`**：配置禅道连接信息（服务器 / 账号 / 密码 + 常用项目）

#### 工时来源与记录缓存（summary）

- **时长** = daemon 记的 session `activeMinutes`（gap-aware 估算实际编码活跃时长，**不是 AI 估**），换算成小时
- **文案 work + 归属 task** = 开发时 `note` 记到 `summary-YYYY-MM-DD.json` 的一句话结论（按项目 + 日期；**文件名日期取 `sessions.json.date`**，跨午夜报当天会话不错位）；task 不确定时记 `-1`，/report 时集中匹配；未记 note 的会话才走 AI 语义匹配
- **note 工时水位**：每条 note 拍快照当时 session 的 `activeMinutes`（`notedActiveMinutes`）。同一会话多条 note 时，按水位**切时间段拆工时到各 task**（段长 = 当前水位 − 上一水位），实现「一个会话干多个任务、工时按段分」

#### 按项目隔离（每次只报当前项目）

`/report`（`plan`/`auto`/`commit`）**只处理当前项目**的工时——脚本靠 `process.cwd()`（`$CLAUDE_PROJECT_DIR || cwd`）识别项目，数据按项目分目录隔离，**没有「一次报多个项目」的选项**：

| 项 | 范围 |
| --- | --- |
| `sessions.json` / `summary-*` / `submitted.json` / `plan.json` | 全在 `projects/<编码cwd>/` 下，各项目互不可见 |
| `/report` 提交 | 锁定当前项目；只有当前项目记的 note 才会被读到 |

- **报多个项目**：分别到各项目目录跑（最省事是在各项目里直接开 Claude Code 会话再 `/report`），一天可多次提交。
- ⚠️ **cwd 必须对**：cd 错目录或 `$CLAUDE_PROJECT_DIR` 指错 → 读到空 `sessions.json`（报「无当天会话数据」）；在 A 项目记的 note，去 B 项目 `/report` 看不到。
- **dashboard ≠ report**：本地 dashboard / tokenserver 是**全局**的（所有项目、多台机器按 cwd 分组展示，看全貌用这个）；`/report` 提交禅道则严格限定当前项目。

#### 提交逻辑（`plan` → `render` → `commit`）

plan 按 session 产出 item，commit **按 item 粒度**逐条提交——每个 `resolved` item = 一次独立 `POST /tasks/{taskId}/estimate`（`{date, work, consumed=hours, left=剩余-hours}`，禅道 20.7 前自动降级旧请求体）：

| item 状态 | 含义 | 提交时 |
|---|---|---|
| `resolved` | 有 note / 分支名含任务号 / 增量补报 | ✅ 逐条 POST |
| `needs_semantic` | 无归属，待 AI 匹配 | ❌ 拒（归属没定全） |
| `already` | 已提交且增量 <15min | ⏭ 跳过 |
| `skipped` | 主动跳过 | ⏭ 跳过 |

**多任务分开提交**（不只按会话）：
- 多会话各属不同 task → 各一次 POST
- **单会话多 note、不同 task** → 按水位切成多段，每段一个 item → 多次 POST 到多个 task，工时按时段分配
- 同一会话多 note 同一 task → 同样按 note 切段，多次 POST 到同一任务（`consumed` 累加、`left` 递减，总工时正确）
- 已提交会话的**增量补报**不拆：取最后那个 task，水位之后的 note work join 成一条，单次 POST（只交 `activeMinutes − 上次水位` 那段）

**三道闸 + 防重**：
- commit 前置检查：有 `needs_semantic` / 有 `resolved` 缺 work / 距上次 commit <30min（冷却）→ 拒；per-item `try/catch`，单条失败不挡其他
- **防重 `submitted.json`**：按 `日期 → 会话 → {tasks, hours, minutes}` 记，`minutes` = 提交时该会话 `activeMinutes`（**水位**）；再报同会话只算水位之后的增量，不重复算已交时段
- 成功后自动学习 `repo → 禅道项目` 映射（`mappings.json`），下次同仓库自动归属

#### 禅道数据缓存（`cache.json`）

禅道项目/任务/执行本地缓存于 `zenpilot/cache.json`（全局），`plan` 默认读缓存不联网。设了 `zentaoCacheTtlMin`（设置页「禅道 → 刷新间隔」）后**过期自动重拉**——下次 `/report`/`/daily`/`/weekly` 时若缓存超过 TTL 自动联网刷新，无需手动 refresh。

#### Dashboard 禅道模块（与 skill 数据同源，非 skill）

dashboard 另有禅道可视化模块：「禅道」页查看任务/项目缓存（`/api/zentao-cache`，可手动刷新）；「日报 / 周报」页从禅道 efforts 汇总生成 HTML 预览（`/api/reports/daily` `/weekly`，带 token 静态链接）＋ AI 日 / 周总结；「设置」页可配禅道账号 / 上报地址 / 刷新间隔 / AI 提交标识。

详见各 skill 的 `SKILL.md`。

## 安装（用户）

两种方式，任选其一。

### 方式一（推荐）：npx 一键安装

```
npx shine-worklog install
```

> 国内 npm 若默认走镜像（npmmirror），新版同步有延迟；拉不到最新版时加 `--registry=https://registry.npmjs.org/` 指官方源。

一条命令完成：

1. 自动检测并安装运行时 **Bun**（1.1+，国内镜像优先 `npm i -g bun`，否则走官方脚本）；
2. 部署 plugin 到 `~/.claude/plugins/cache/shine-worklog/shine-worklog/<version>/`；
3. `bun install` 装运行时依赖（marked / react / react-dom）；
4. 注册 marketplace + plugin + 启用（写 `known_marketplaces.json` / `installed_plugins.json` / `settings.json` 三处 JSON）；
5. 拉起 daemon、打印 Dashboard 链接。

装完**重启 Claude Code**，`/plugin` 列表会显示 `shine-worklog`（✔ enabled）；开新会话即触发 SessionStart hook，事件出现在 Dashboard。

卸载：`npx shine-worklog uninstall`（⚠️ 不要 `sudo` —— sudo 没有 nvm 的 PATH，会 `npx: command not found`）。

### 方式二：`/plugin marketplace add`（从 GitHub）

源码直跑，需要 Bun 运行时——**没装也行**：首次任意 hook 事件时 `launcher.cjs` 会自动装（`npm i -g bun`，失败回退官方脚本，约 10-30s；安装进度仅 SessionStart 回显到 stderr，且 SessionStart 已配 200s 超时兜底，进度见 `<DATA_DIR>/log/bun-install.log`（Win：`%LOCALAPPDATA%/shine-worklog/`，mac/linux：`~/.local/share/shine-worklog/`））。想首次更快可先手装 `npm install -g bun`，或官方脚本——Windows `powershell -c "irm bun.sh/install.ps1 | iex"`，macOS/Linux `curl -fsSL https://bun.sh/install | bash`。

**从 GitHub：**

```
/plugin marketplace add  china-shine/shine-worklog
/plugin install shine-worklog@shine-worklog
```

clone 后只有源码；首次 hook 事件时 `bin/launcher.cjs`（node）自动 `bun run src/hook/main.ts`，daemon 同理 `bun run src/daemon/main.ts`。

> 需机器能访问 github.com（国内通常要走代理）；`marketplace add` 走 git，代理配好即可。

**从本地目录（开发自测）：**

```
/plugin marketplace add <本仓库本地路径>
/plugin install shine-worklog@shine-worklog
```

直接读本机源码，改完即时生效（无需 build）。

---

## 查看页（Dashboard）

装完**开新会话**即生效。两种打开方式：

- **自动**：每次打开或回到会话（`source=startup` 或 `resume`，非 `clear/compact`），hook 会在会话顶部打印一行 Dashboard 链接（走 Claude Code 的 `systemMessage` 机制，直接显示给你；裸 stdout 只注入 assistant 当 context，用户不可见）。复制到浏览器即开。
- **手动**：`bun run src/cli/main.ts ui` —— 打印带 token 的链接并尝试打开浏览器。

> daemon 没起来也不报错：SessionStart hook 会先拉起 daemon 再读 token 打印；万一拉起失败则静默跳过（退出码恒 0，绝不阻断 Claude Code）。

### 局域网访问（其他设备看 Dashboard）

daemon 默认绑 `0.0.0.0`（所有网卡），打印的 Dashboard 链接自动用**第一个真实网卡的局域网 IP**（`getPrimaryIpv4` 跳过 vEthernet/VMware/docker 等虚拟网卡）。开新会话时链接形如 `http://192.168.x.x:36666/ui?t=...`，手机/平板/局域网其他设备直接能用。仅本机回环用时设 `SHINE_WORKLOG_HOST=127.0.0.1` 再 restart daemon。

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
bun run build:ui             # 只 bundle ui/* → src/daemon/ui-assets.ts（不 build exe，改 UI 用）
```

- `dist/install.cjs`：`npx shine-worklog` 的入口，发布到 npm。`scripts/build-install.ts` 把 `src/install/*` 打成单文件 cjs bundle。
- `bin/<plat>-<arch>/`：`bun build --compile` 产出的**本机**二进制，开发自测用、**gitignored、不入库、不发布**。launcher 优先用它、没有则 `bun run src/...`，所以不 build 也能跑。
- 发版到 npm：`bash scripts/publish.sh`（`build:dist` → `npm pack` → `fix-tarball-mode.py` 修 `+x` → `npm publish <tgz>`；`build:dist` = `build:ui` + `build:install`，故意跳过 exe——exe 不入 npm tarball）。详见 [`CHANGELOG.md`](./CHANGELOG.md)。

### 源码调试（直接 bun run，不经插件 / exe）

调试 daemon / hook / UI 的首选：绕开插件机制与 `bin/launcher.cjs`，全程 `bun run` 源码，改 `.ts` 即时生效、不 build 任何二进制。

> 不用 `/plugin install` 本地目录的原因：`launcher.cjs` 见 `bin/<plat>-<arch>/hook.exe` 存在就优先 spawn 二进制（固化旧版），插件路径还可能复制到 cache；下法彻底绕开。

**① 起 daemon**（源码模式，占住 36666）：

```bash
bun run src/daemon/main.ts
```

Dashboard：`http://localhost:36666/ui?t=<token>`，token 在 `%LOCALAPPDATA%/shine-worklog/daemon.pid`，或 `bun run src/cli/main.ts ui` 打印带 token 链接。已有个同源 daemon 在跑时会自检复用、不重复启动（`isOursAlive`）。

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

### Transcript 数据中枢（watcher + SQLite，替代轮询）

本地 dashboard 的 token/session 数据不再轮询扫描 transcript，改成**事件驱动 + SQLite 中枢**（2026-07-23 重构，旧 `scanSessions` 轮询 / `scanCache`(10s TTL) / `token-cache` / 500ms 预热已全部删除）：

- **watcher 推（`src/daemon/watcher.ts`）**：`fs.watch` 监听 `~/.claude/projects`，文件变化/新增只把 SQLite 对应行标 `dirty`（不读内容、极轻）；Win/mac 用单个 recursive watcher 覆盖整树，Linux 不支持 recursive 故遍历每个 project 目录分别 watch + 新目录补挂；高频微事件 debounce 250ms 合并。watcher 挂了不影响 daemon（消费者 5min 兜底扫补救）。
- **消费者增量算（`src/daemon/transcript-consumer.ts`）**：每 2s tick 只处理 `dirty` 文件——增量读上次 offset 之后的尾部（半写行留下次补）→ 合并 entries → 全量重算 token/activeMs（`sessionUsageAndActiveFromEntries`，与旧扫描口径逐字节等价）→ 写回 `transcript_sessions` 表、清 `dirty`。每 tick 限量（100 文件 / 50 session）防暴增。
- **兜底全扫**：每 5min 一次 `fullScanBackstop`，补救 `fs.watch` 漏事件 + daemon 启动后的首次 baseline（watcher 只管启动后的变化）。
- **前端直读 SQLite**：`/api/projects` / `/api/sessions?cwd=` / `/api/report` 改查 `transcript_sessions`（消费者已算好），请求时不再扫盘。
- **前端三级钻取保留**：L1 项目表 → L2 session 表（`PagedTable` 服务端分页 + 序号 + 骨架行 + 刷新）→ L3 聊天（`/api/transcript` 懒加载）。

token 口径仍逐字段对齐 ccusage（静止 session 全等）。详见 `src/daemon/store.ts`（schema）、`watcher.ts`、`transcript-consumer.ts` 注释。

## 目录

```
.claude-plugin/  plugin.json、marketplace.json（plugin 元信息 + 自托管市场）
hooks/           hooks.json（plugin hook 注册，command 调 node launcher.cjs）
bin/             launcher.cjs（hook 分发器）；<plat>-<arch>/ 本机编译产物（gitignored，不入库）
src/             shared/ daemon/ hook/ cli/ install/（多端共用源码）
skills/          禅道工时 skill（/report /prepare /daily /weekly /lastweek /amend /mappings /mark /setup，各含 SKILL.md + scripts）
ui/              查看页（React/TSX，由 daemon 内嵌 HTTP 服务）
dist/            install.cjs（npm 发布产物，gitignored）
scripts/         build.ts、build-ui.ts、build-install.ts、publish.sh、fix-tarball-mode.py、verify-transcript-parity.ts、parity-vs-ccusage.ts（transcript 对齐校验）
tokenserver/     报表上报接收服务（独立子项目,bun+sqlite+React,可打包 Linux 二进制;见 tokenserver/README.md + tokenserver/数据说明.md）
```

## 三个目录:工作目录 / plugin cache / DATA_DIR

开发与运行时涉及三个目录,性质不同,别混淆:

| 目录 | 路径 | 性质 | 内容 |
| --- | --- | --- | --- |
| 工作目录 | git 仓库(如 `Desktop/workspace/livesetting`) | 开发源码 | 你改的源码,git 跟踪 |
| plugin cache | `~/.claude/plugins/cache/shine-worklog/shine-worklog/<version>/` | 安装的代码副本 | Claude Code 实际加载运行的代码(install 时从 npm/本地复制,版本化目录) |
| DATA_DIR | `%LOCALAPPDATA%/shine-worklog/`(见下「数据位置」) | 运行时数据 | daemon 产生的状态/数据库/日志/禅道数据 |

```
工作目录 ──install / --force──▶ plugin cache(Claude Code 实际跑这个)──运行──▶ DATA_DIR(数据写这)
```

> ⚠️ **改源码不生效的常见原因**:Claude Code 加载插件、hook 执行、daemon 运行、skill 调用跑的都是 **plugin cache 里的代码,不是你的工作目录**。改工作目录源码后,需 `npx shine-worklog install --force` 重装(同步到 cache);或开发期用「源码调试」模式绕开插件,直接 `bun run` 工作目录源码。
>
> 注:plugin cache 和 DATA_DIR 下都有 `bin/`,内容不同——cache 的 `bin/` 是 `launcher.cjs`(hook 分发器),DATA_DIR 的 `bin/` 是 `spawn-daemon-hidden.vbs`(开机/会话自启脚本)。

## 环境变量

> 1.3.0 改名：`SHINE_WORKLOG_*`（旧 `SHINE_CODE_SUBMIT_*` 仍兼容一代，读取处双名 fallback）。

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `SHINE_WORKLOG_HOST` | daemon 监听地址。默认 `0.0.0.0`（绑所有网卡，局域网可访问）；仅本机回环用时设 `127.0.0.1` | `0.0.0.0` |
| `SHINE_WORKLOG_DAEMON_CMD` | 拉起 daemon 的完整命令（开发期覆盖）。未设时 fallback 优先级：`SHINE_WORKLOG_DAEMON` env → 同目录 daemon 二进制 → `bun run` 源码 | `bun run src/daemon/main.ts` |
| `SHINE_WORKLOG_DAEMON` | 仅 `bun run` 入口路径（未设时同上 fallback） | `src/daemon/main.ts` |
| `SHINE_WORKLOG_DEBUG` | 开启 daemon DEBUG 日志 | 无 |

## 数据位置

`%LOCALAPPDATA%/shine-worklog/`（Windows）或 `~/.local/share/shine-worklog/`（macOS/Linux）—— **所有数据统一在一个根**（1.3.0 起改名+统一，ZenPilot 数据从 `~/.zenpilot/` 挪到此）：

```
daemon.pid          pid/port/token/startedAt
daemon.token        持久化 token（daemon 重启/自动升级复用同一 token，Dashboard 链接不变）
spool/*.json        待消费事件（每事件一文件，原子写）
log/daemon.log      日志（按大小轮转）
db/events.sqlite    事件库（`events` 幂等去重）+ transcript 中枢（`transcript_files`/`transcript_sessions`），按 cwd 隔离
settings.json       上报与更新配置（reportUrl/reportIntervalMin/autoUpdate/水位 lastReportAt+lastFullReportAt/禅道缓存 TTL zentaoCacheTtlMin/AI 提交标识 aiSubmitMark/daemon 升级检测 lastDaemonVersion）
zenpilot/           禅道工时填报数据（原 ~/.zenpilot/，1.3.0 统一进此；skill 短期工作区，长期台账在 tokenserver worklogs 表）
  config.json         禅道连接（url/account/password/projectIds，明文密码 chmod 600）
  mappings.json       仓库→项目映射（repoToProject 仓库名→禅道项目ID / branchToTask / projectNames；/report commit 时自动学习）
  cache.json          禅道任务/执行缓存（减少重复 API 调用）
  projects/<编码cwd>/ 按项目隔离（编码 = cwd 非字母数字→"-"，对齐 ~/.claude/projects/ 编码）
    plan.json           当天提交计划（每次 plan 覆盖，只存当天；items 含 status/work/taskName/hours）
    sessions.json       当天从 daemon 采集的会话（每次 collect 覆盖，只存当天；算工时用；其 date 字段定 summary 文件名）
    summary-YYYY-MM-DD.json  开发时 note 积累的 work+task 结论（按日期，文件名日期取 sessions.json.date 防跨午夜错位；每条带 notedActiveMinutes 水位，多 note 按水位拆工时到各 task）
    submitted.json      防重 + amend 索引（按 日期→会话→{tasks,hours,minutes 水位} 累积；minutes 是提交时 activeMinutes 水位，再报同会话只补增量）
```

## 报表上报

daemon 默认每 10 分钟（`reportIntervalMin`）或手动（Dashboard「上报」按钮）把会话/token 聚合报表 POST 到 `reportUrl`（默认 `http://47.98.221.20:36667/api/report`，可在「设置」页改）。接收端 [`tokenserver/`](./tokenserver/README.md) 按 **用户 → 项目 → token** 三级展示。

**上报身份 = `git config user.name`**：采集不到（机器未配 `user.name`，如部分 CI/容器/新机）时**跳过本次上报**，不再以「未知用户」上传；手动上报按钮会提示「已跳过：未采集到 git user.name,跳过上报(无上报身份)」。配置 `git config --global user.name <名字>` 后即恢复上报。

**上报范围与 token 显示**：token 统计**不受 `aiStatsHosts`（AI 占比 host 白名单）限制**——白名单只管 git 代码占比（`git_changes` 那条线），token 是全局的：

- **数据源 = transcript，与 git 账号/仓库无关**：本机只要跑过 Claude Code（`~/.claude/projects/**/*.jsonl`），daemon 就算得出 token，不管项目 git remote 是什么、配没配仓库。
- **配了 `git user.name` 即整机上报**：`buildReport` 扫全量 transcript session，这台机器**所有项目**的 token 一起上报、全部显示。
- **一台机器 = 一个身份**：`git user.name` 读全局配置，本机所有项目都归到该用户名下；多台机器同名 `user.name` → tokenserver 合并为同一用户、token 累积（tokenserver 总量会大于单机 dashboard 属正常）。
- **没配 `user.name`**：整台上报跳过，tokenserver 上这台机器任何 token 统计都看不到（即使有 transcript 数据）。

**上报 body gzip 压缩**：daemon POST 时带 `content-encoding: gzip` + gzip body，tokenserver 按 content-encoding gunzip（兼容不压缩的老上报）。体积：97 session 39KB→gzip 10KB。

**增量上报（已实现）**：`settings.json` 持久化水位 `lastReportAt`，每次只发 `last_activity >= 水位` 的 session，成功/无变化后推进水位（失败不推进，下次重发同批不丢），重启不重置。配 **24h 全量校准**：`lastFullReportAt` 每满 24h（或手动「全量上报」）强制 `since=0` 重锚一次，防 tokenserver 数据丢/重置后 daemon 不自愈。tokenserver 端 `saveReport` upsert by sessionId 幂等，天然兼容增量。

**部署顺序**：tokenserver 先升级（gunzip 接收），daemon 再上报 gzip。上报超时 60s、tokenserver `Bun.serve` 显式 `maxRequestBodySize` 256MB（万级 session / 全量回填防 413）。

## AI 代码占比 + 禅道工时台账（tokenserver 侧指标）

除 token 外，tokenserver 还聚合两类**随报表一起上来**的数据，完整口径见 [`tokenserver/数据说明.md`](./tokenserver/数据说明.md)。

**AI 代码占比** = AI 代码行 / git commit 代码变化行（总览 KPI 卡，点「分母」按钮看按项目拆分）：
- **分子 Σ aiAdded**：daemon 从 events 表 PostToolUse（Edit/Write/MultiEdit/NotebookEdit）的 `structuredPatch` 提取 AI 改动行，与 `git log -p --unified=0` 采的 commit added 行做**行级内容匹配**（认行不认 commit，手动 commit 的 AI 代码也能识别）；每个 commit 的 `aiAdded` 随报表 `gitCommits` 上报（`src/daemon/lines.ts` + `aggregate.ts`）。
- **分母 Σ(added+deleted)**：commit 代码变化行，tokenserver 落 `git_changes` 表（hash 幂等 upsert，aiAdded 取 MAX）。
- **只统计有 transcript 覆盖的 commit（`aiAdded>0`）**：早期版本前 / 别机器未装采集的 commit 无 AI 行记录，不进分母，避免拉低占比；占比卡副标直接显示分子/分母。
- **host 白名单 `aiStatsHosts`**：tokenserver `data/config.json` 可配数组（如 `["8.130.168.121"]`），只统计 `gitRemote` 命中指定 host 的 commit（公司 git 仓库），排除 localhost / 个人 / 无 remote；空或未配 = 不过滤（向后兼容）。改后重启 tokenserver 生效。
- **daemon 升级全量回填**：daemon 启动发现版本变化（`lastDaemonVersion`）会重置 `lastFullReportAt`，下次上报强制全量（since=0）重拉 gitCommits，历史 `aiAdded` 由 tokenserver upsert MAX 幂等补齐。

**禅道工时台账**：daemon 每次上报**全量**读 `zenpilot/projects/*/plan.json` 的 `status=resolved` 条目（`src/daemon/worklog.ts`，忽略增量水位），随报表 `worklogs` 上报 → tokenserver 落 `worklogs` 表（`(gitUser,date,sessionId,taskId)` 复合 upsert 累积，跨项目/跨天长期保留）→ 成员详情「禅道工时」表（分页，任务名可点跳禅道）。

## Token 统计逻辑（与 [ccusage](https://github.com/ccusage/ccusage) 对齐）

报表和会话树的 token 数据**基于 Claude Code transcript**（由 watcher + SQLite 中枢增量维护，见上节「Transcript 数据中枢」；不依赖 hook 是否抓到），算法与 `ccusage claude session` 一致——同一份 transcript 产出的四个字段逐字段相等。

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
               （无 `cache_creation` 子对象时回退 `cache_creation_input_tokens`）
cacheRead     = cache_read_input_tokens
```

**去重**：按 `message.id + requestId` 去重（含子代理 sidechain 重放兜底）；同一 key 多条时的取舍顺序：**非 sidechain 优先 → total 更大 → 带 speed**。

**Session 归并**：父 transcript `projects/<project>/<session>.jsonl` 与同目录 `<session>/subagents/*.jsonl`（子代理）合并为**一个 session**，跨文件全局去重后求和。

**显示口径 = 原始总量**（= ccusage `totalTokens`）：

```
rawTotal = input + output + cacheCreation + cacheRead
```

> 1.0.12 之前用计费口径 `realInput = input + cacheCreation×1.25 + cacheRead×0.1`（缓存读打 0.1 折），现改为原始总量 `rawTotal`，与 ccusage 完全一致。

**聚合**：按项目（cwd，优先级：hook 真实路径 → transcript 首条 cwd → 解码项目名）汇总各 session；同名项目用「父目录/项目名」消歧；全局 token 总量 = 所有 session 之和。`0-token` 的空 transcript 不计入 session 数（对齐 ccusage）。

实现：`src/daemon/transcript.ts`（逐行解析/校验/去重 + session 归并）、`src/daemon/claude-scan.ts`（projects 根解析 / jsonl 收集）、`src/daemon/aggregate.ts`（按 cwd 分组聚合）、`src/daemon/server.ts`（报表/会话/分级接口）。

## 关键设计点

- **目录式 spool + 原子 rename**：每事件一文件，规避多进程并发 append 损坏。
- **幂等**：`(sessionId, eventId)` 唯一约束 + `INSERT OR IGNORE`，热路径与回捞共享，允许重放。
- **热路径优先**：直接 POST，连接失败才探测/拉起（健康路径单次往返）。
- **认自己人**：`/api/health` 返回 `service` 字段，Hook 校验后才认端口归属。
- **默认绑 0.0.0.0 + token**：数据接口（`/api/*` 除 `/api/health`）均鉴权，静态页（`/`、`/ui`）与健康端点开放；默认暴露给局域网（方便其他设备访问），仅本机回环用时设 `SHINE_WORKLOG_HOST=127.0.0.1`（见「局域网访问」）。
- **监听/连接地址分离**：daemon 监听用 `LISTEN_HOST`（默认 0.0.0.0，env 可配）；hook POST / cli / 探活 连接 daemon 固定走 `127.0.0.1` 回环（daemon 即使绑 0.0.0.0 也含回环），最快最稳。
- **打印链接用真实网卡 IP**：`PUBLIC_BASE_URL` 取第一个非虚拟网卡的 IPv4（跳过 vEthernet/VMware/docker），显示与打开浏览器共用同一地址（本机、局域网通用）；无非回环网卡时才回退 `localhost`。
- **自动更新（主动外联 npm）**：`autoUpdate` 默认开，daemon 启动时 + 每 `autoUpdateIntervalMin`（默认 60 分钟）查 `registry.npmjs.org` 最新版，有新版后台 spawn `npx shine-worklog install` 升级。介意外联可在 settings.json 设 `autoUpdate:false`，或 CLI `update` 手动触发。
- **自启动 + 自愈**：任意事件故障路径都能拉起；重复实例启动时自检退出，crash 只删属于自己的 pid。
- **hook 永不阻断**：launcher 与 hook 退出码恒 0，Bun 缺失时自动安装或静默跳过，绝不影响 Claude Code 主进程。
