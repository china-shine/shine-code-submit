# 更新日志

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.20 — 2026-07-20

修复 daemon cwd 反斜杠转义脏数据 + tokenserver 前端会话表增强。

> 1.0.19 因发版时绕过 `scripts/publish.sh`、漏跑 fix-tarball-mode,导致 `dist/install.cjs` 无 +x 位(Linux `npx` Permission denied)作废;1.0.20 为修复重发,内容相同。

### 改动
- **cwd 转义脏数据修复**:无 hook 的 session 此前用 `decodeProjectCwd` 反推 Claude Code 的有损编码目录名(中文/空格/括号编码成 `-`),反推出大量连续反斜杠(如 `ai数据同步平台\game` 显示成 `ai\\\\game`),导致 tokenserver 同项目拆多行、项目数虚高(34→实际 27)。改为扫描时直接读 transcript jsonl 首条 `cwd` 字段(无编码损失),`decodeProjectCwd` 仅极端兜底:`transcript.ts` 加 `readFirstCwd`、`token-cache.ts` 加 `getSessionCwd`(mtime 缓存)、`ScannedSession` 加 cwd 字段、`server.ts` 两处(/api/sessions + buildReport)接入三级兜底(hook cwd ?? jsonl cwd ?? decode)。
- **tokenserver 存量愈合**:upsert WHERE 加 `OR excluded.cwd IS NOT sessions.cwd`,历史脏 cwd 在下次上报(即使 lastActive 不变)被干净值覆盖,无需清库。
- **会话表分页 + 固定列宽**:`RecentSessionsTable` 去掉 slice(0,20) 硬截断,改 20/页(数字页码窗口 10 + 省略号 + 首尾、居中、当前页高亮);`table-fixed` + colgroup 固定 9 列宽,翻页不再抖动。
- **首列日期带年**:`fmtDateFull`(YYYY-MM-DD HH:MM)用于会话表首列。
- **成员趋势图 granularity**:成员详情趋势写死 `bucketByDay`(日/周/月无变化),改 `bucketByGranularity` 并从 App→MemberPage→MemberDetailPage 透传 granularity,与概览页一致。
- 验证:rebuild daemon 后 /api/report 全部 cwd 干净(含中文路径);tokenserver upsert 单元验证愈合;前端本地 dev 验证分页/列宽/趋势切换。

## 1.0.18 — 2026-07-20

新增「对话总时长」(gap-aware 活跃时间估算),补全 KPI / 会话表 / 成员列表 / 成员详情四处时长展示。

### 改动
- **对话总时长(gap-aware)**:`transcript.ts` 新增 `sessionActiveMs` —— 收集 session(父 transcript + `subagents/*.jsonl`)所有经 messageId 去重的合法 timestamp,1h 间隙截断视为离开、每段 burst +10min buffer(单点 burst 也给 10min,避免「只发一条=0 时长」)。复用 ccusage 的严格 timestamp 校验与 `pushDedupedEntry` 去重,口径与 token 一致;`cost.total_duration_ms` 是运行时字段不落盘,用不了。
- **activeMs 贯穿全链路**:`ScannedSession`/`ReportSession` 加 `activeMs`(`token-cache` 带 mtime 缓存);tokenserver `sessions` 表加列 + ALTER 自动迁移(旧库兼容,历史行 DEFAULT 0,旧 daemon 上报 `?? 0` 兜底);前端 `derive` 加 `globalTotals.activeMs`/`flattenSessions`/`dailyStats.dur` + `fmtDuration`(`<1m`/`Xm`/`Xh Ym`)。
- **四处时长展示**(同一 gap-aware 口径):overview「对话总时长」KPI + 按日 sparkline、最近会话表时长列、成员列表时长列、成员详情时长 KPI。
- **最近会话表**:删「路径」列(项目名已在「项目」列,完整 cwd 冗余占宽),9 列。
- **验证**:当前对话 session 算出 ~57min;89 个历史 session 全部立即算出 activeMs(基于 transcript,无需累积);daemon `buildReport` → POST tokenserver 200 ok → `/api/reports` 透传 activeMs。

## 1.0.17 — 2026-07-20

上报新增「会话标题」字段（来自 transcript 首条 user 提问）。

### 改动
- **ReportSession 新增 title**：daemon 扫描 transcript 取首条 user 消息文本作为会话标题，随报表上报（供 tokenserver 等接收方在最近会话表展示，比 sessionId 前 8 位可读）。
- 新增 `readFirstUserText`（transcript.ts）/`getSessionTitle`（token-cache.ts，带 mtime 缓存）；`ScannedSession`/`ReportSession` 加 title 字段。
- 过滤 Claude Code 注入的系统消息（local-command-caveat / command-* 等，以 `<` 开头），不误作标题。

## 1.0.16 — 2026-07-09

会话树与报表统一数据源（修复两边项目/session 不一致）。

### 改动
- **/api/sessions 改 scan 驱动**：会话树改用扫描 transcript 的 session 集合（与报表同源），不再只显示 hook 抓到的 session；scan session 用 hook 信息补 cwd/eventCount/lastType。
- **hook cwd 一致解析**：会话树与报表对「跨 cwd 的 session」都取最新 hook cwd（首个，按 last_active DESC），不再被分到不同项目。
- scanSessions 加 2s TTL 缓存（会话树每 2s 轮询，避免每次全扫）。
- 验证：会话树与报表的 session 集合（104）、每个 session 的 cwd、项目数（31）完全一致。

## 1.0.15 — 2026-07-09

对话视图与报表统一 transcript 来源。

### 改动
- **对话视图回退扫描**：`/api/transcript` 在 hook 未提供 `transcript_path` 时，回退按 sessionId 扫描 `projects/` 找 transcript（新增 `findTranscriptPathByScan`）。
- 效果：报表里的所有 session（含 daemon 未捕获 hook 的旧/外部 session）都能点开看对话，不再「找不到 transcript_path」。
- 验证：scan-only session（hook 无）现可打开（345 条消息）；hook session（b97b7212）1130 条消息正常。

## 1.0.14 — 2026-07-09

报表项目导航去重。

### 改动
- **按真实 cwd 分组**：同 cwd 的 session 合并到一个项目，修复「同一项目在导航出现多条」（如 livesetting 重复出现）。
- **同名消歧**：不同项目若末段同名（如两个 `test`），用「父目录/项目名」区分（`workspace/test`、`ai/test`），导航不再重名。
- 报表导航改用项目名 `p.name` 展示。
- token 总量与 ccusage 仍逐字段一致（分组不影响总量）。

## 1.0.13 — 2026-07-09

报表 session 列表对齐 ccusage 细节。

### 改动
- **排序**：报表页 session 按 lastActivity 倒序（最新在前），不再随文件系统乱序。
- **过滤空 session**：跳过 0-token 的空 transcript，session 计数对齐 ccusage（如 116 → 104）。
- **验证**：daemon `/api/report` 与 `ccusage claude session` 在 session 数与 token 总量上逐字段相等（104 session / 1,518,197,992 tokens）。

## 1.0.12 — 2026-07-09

token 统计完全对齐 ccusage（显示改原始总量 + 扫描所有 transcript）。

### 改动
- **显示口径**：移除 realInput 计费代理（缓存读×0.1 缩水），前端 + tokenserver 全部改显示原始总量 rawTotal（input+output+缓存写+缓存读 = ccusage totalTokens）。
- **session 扫描**：新增 `claude-scan`，直接扫 `~/.claude/projects` 下所有 transcript（不再只统计 hook 抓到的 session），按 session 归组；`/api/report` 的 token 来源改为扫描结果，与 `ccusage claude session` 的 `totals` 逐字段相等。
- **Overview**：Token 总量 KPI 改读 `/api/report` 扫描总量（ccusage 口径）。
- **验证**：scanSessions 全局总量与 ccusage 字节级一致（1,506,182,124 tokens，四字段全等）。

## 1.0.11 — 2026-07-09

session token 汇总进一步对齐 ccusage session 口径(逐行校验 + 去重 + 子代理归并)。

### 改动
- **去重**:新增 `message.id`+`requestId` 全局去重(含 sidechain 重放兜底),偏好非 sidechain → total 更大 → 带 speed。避免同条 usage 被重放/跨文件重复累加。
- **子代理归并**:`sessionTranscriptFiles` 把同目录 `subagents/*.jsonl` 归并到父 session,`sumSessionUsage` 跨文件去重求和,对齐 ccusage session 口径;`token-cache` 改用之,缓存 key 改为父+子代理复合 mtime。
- **校验门**:逐行复刻 ccusage 的 `usage` 标记检测、null 黑名单字段丢弃、非 semver `version` 丢弃、严格 ISO8601 时间戳、字段非空校验。
- **cache_creation 细分**:有 `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` 时用 5m+1h 求和,否则回退扁平 `cache_creation_input_tokens`。
- **验证**:新增 `scripts/verify-transcript-parity.ts`(复刻 ccusage 测试用例 + 细分/校验/归并门,10 例全过)。

## 1.0.10 — 2026-07-09

修 transcript usage 漏算(对齐 ccusage)。

### 改动
- **sumTranscriptUsage**:新增直接扫 JSONL 每行 `message.usage` 累加(对齐 ccusage),不依赖对话解析。`token-cache` 改用之。
- **修复**:`parseTranscript` 只 push 有 text/thinking/tool_use 的 assistant 消息,漏掉纯 usage 行(无文本内容但带 usage 的 API 响应);新方法扫每行 usage 不漏。

## 1.0.9 — 2026-07-09

token 统计改计费口径 + 修报表 session 重复。

### 改动
- **计费口径**:`realInput` 改为 `input + cacheCreation×1.25 + cacheRead×0.1`(Anthropic 计费口径,对齐官方/智谱后台)。之前 cacheRead 全量计入(真实处理量),比计费高约 7 倍。
- **修重复**:`buildReport` 同 sessionId 跨 cwd 只算一次(归最近 cwd),避免 totals/项目合计重复累加(会话期间 cd 导致同 session 在多个 cwd 出现)。

## 1.0.8 — 2026-07-09

Dashboard 数据上报页 session 表格增加代码变更列。

### 改动
- **Dashboard**:数据上报页(ReportModule)session 表格加「代码变更」列(+A -D M);项目标题加行数汇总。1.0.7 漏了 daemon Dashboard(只加了 tokenserver),此版补上。

## 1.0.7 — 2026-07-09

报表 session 增加代码变更行数(添加/删除/修改分开统计)。

### 改动
- **报表行数**:session 维度增加代码变更行数(added 纯增 / deleted 纯删 / modified 一删一加配对),三者不重复。
- **数据来源**:PostToolUse 事件的 `tool_response.structuredPatch`(JSdiff,+/- 前缀),无需引入 diff 库;仅 Edit/Write/MultiEdit/NotebookEdit。新建文件回退 content 行数。
- **daemon**:`ReportSession.linesTotal` + `ReportProject.totalLines` + `ReportTotals.lines`;按 sessionId+lastActive 缓存。
- **tokenserver**:sessions 表加 added/deleted/modified 列 + ALTER 迁移(旧库兼容);aggregate 累加 project/user 级合计;UI session 表加「代码变更」列(`+A -D M`)。

## 1.0.6 — 2026-07-09

自动更新:daemon 后台定时检测 npm 新版本并自动升级。

### 改动
- **自动更新**:daemon 启动时 + 每 `autoUpdateIntervalMin`(默认 60)分钟查 npm registry latest,有新版(versionGt 语义比较,只升不降)→ spawn detached `npx shine-code-submit@latest install` 后台升级。默认开启。
- **settings**:加 `autoUpdate`/`autoUpdateIntervalMin`/`latestVersion` 字段。
- **cli update 命令**:手动触发检测+升级(force,忽略 autoUpdate 开关)。
- **dashboard 设置页**:加自动更新开关 + 间隔 + 当前/最新版本显示。
- **降级保护**:`versionGt` 语义比较,本地比 npm 新(如发版前 build)时不误降级。

## 1.0.5 — 2026-07-09

升级后自动切换 daemon 到最新版本。

### 改动
- **版本感知探活**：`isOursAlive` 升级为 `probeDaemon`(返回 alive+version);复用 daemon 前比较运行中版本与当前 `SERVICE_VERSION`,不一致则停旧启新。
- **方式1 `npx install`**:`startDaemonWithBun` 检测旧版 daemon → 自动停旧启新(不再「跳过启动」导致版本停滞)。
- **方式2 `/plugin update`**:hook `postOnce` 读 `/api/hook` 响应 version,版本旧则停旧启新(`/api/hook` 响应加 version)。
- **重构**:`stopDaemon` 抽到 `daemonctl.ts` 复用(cli/install/hook 共用);`ensureDaemon` 改版本感知。

## 1.0.4 — 2026-07-09

文档同步（无功能改动）。

### 改动
- **README**：`/plugin marketplace add` 命令 owner 迁至 `china-shine`；新增「报表上报」段（上报身份 = `git config user.name`，采集不到则跳过）。

## 1.0.3 — 2026-07-09

上报身份校验 + 仓库迁移至 china-shine。

### 改动
- **上报身份校验**：采集不到 `git config user.name`（上报身份）时跳过本次上报，不再以「未知用户」上传到 tokenserver；自动上报记 `skipped` 日志，手动上报按钮区分「上报成功 / 已跳过：未采集到 git user.name / 失败」。
- **GitHub 仓库迁移**：remote 及 package.json / plugin.json / 部署说明 中的 GitHub 链接迁至 `china-shine/shine-code-submit`。
- **UI**：导航栏改固定宽度（`--nav-w` 98px），修复超长会话触发大规模 reflow 时导航栏/会话树左移错位。

## 1.0.2 — 2026-07-08

token 显示修正 + 报表重构 + 默认上报配置。

### 改动
- **token 真实输入**：输入改用 `input + cacheCreation + cacheRead`（直接累加 Anthropic API 原始字段，不乘系数）；之前仅取未缓存 `input_tokens`，漏掉走缓存的输入（实测占输入侧 97%+）。
- **fmtTokens 进位**：新增 B/T 级（两位小数），修复超 1e9 显示成 `1033M` 不进位。
- **报表重构**：`/api/report` 移除提交汇总，改加 `gitRemote`（仓库地址）；新增 `POST /api/report/upload` 手动上报端点。
- **会话/报表 token 三段式**：`输入 X · 输出 Y · 总数 Z`（带标签），导航只显总数。
- **默认上报配置**：`settings.ts` 加 `DEFAULTS`，默认上报 `http://47.98.221.20:36667/api/report`，间隔 10 分钟；`readSettings` 返回 `{...DEFAULTS, ...已存}`。
- **仓库新增 tokenserver**：报表接收服务（bun + sqlite + React），三级展示，可打包 Linux 二进制。独立部署，不入 npm 包。

## 1.0.1 — 2026-07-08

版本号递增以通过 npm 发布（每次 publish 版本须高于已发布版本）。

### 改动
- 版本号 `1.0.0` → `1.0.1`（`package.json` 与 `.claude-plugin/plugin.json`）。
- 运行时版本 `SERVICE_VERSION` 继续由 `package.json` 单一来源派生，无需改代码。

## 0.2.11 — 2026-07-08

新增「数据上报」dashboard 页：跨项目聚合（版本 / git 用户 / 每项目会话数+每会话 token / 提交次数+行数+时间）。后期接服务器上报，现留占位按钮。

### 新增
- `GET /api/report?since=<ms>`（token 鉴权）：按项目(cwd)聚合——每会话 `tokenTotal`（transcript 汇总，带 mtime 缓存）、提交 `count/+added/-deleted/lastTime`、`git config user.name`、全局 `version`。返回 `{version, gitUser, projects[], totals}`。
- `src/daemon/git.ts`：`getGitUser(cwd)`。
- UI「数据上报」模块（`ReportModule.tsx`）：汇总卡 + 每项目卡（会话/token/提交/最近提交时间），展开看每会话 token 明细 + 最近 5 条提交；时间范围选择（全部 / 近 7 天 / 近 30 天）。底部「上报到服务器」**占位按钮**（禁用，后期接远端时启用）。
- 接线：`ModuleId` 加 `"report"`、SideNav「数据上报」、ModuleRouter。
- 数据大多复用现有采集（events/sessions/transcript/commits），无新 DB schema、无新依赖。

### 验证
本机 `/api/report?since=0`：6 项目 / 35 会话 / token 合计（↑27.9M ↓12M）/ 62 提交 / +17508/-993，结构与字段正确。

## 0.2.10 — 2026-07-08

暂时关闭「自动弹浏览器」——Dashboard 链接照常打印，用户自行点开。

### 改动
- 注释 `src/hook/main.ts` SessionStart 里的 `openBrowser`：新会话不再自动弹浏览器（链接仍作 `systemMessage` 打印）。
- 注释 `src/install/main.ts` `openDashboard` 里的 `openBrowser`：安装完不再自动弹（Dashboard 链接仍打印）。
- 保留 `src/cli/main.ts` `ui` 手动命令的 `openBrowser`（用户主动跑的）。
- 想恢复：把那两处 `openBrowser(url)` 取消注释即可。

## 0.2.9 — 2026-07-08

修方式二（`/plugin install`）装 Bun 时「进度」和「Dashboard 链接」都不显示的问题。

### 根因
0.2.7 把装 Bun 的进度/提示打到 hook **stdout**（纯文本）。但 Claude Code 的 SessionStart hook 把 stdout 当**单个 JSON 对象**解析（提取 `systemMessage` 显示链接）；纯文本混入让整个 stdout JSON 解析失败 → 链接文本和进度都不显示（浏览器仍会开，因为 hook 的 `openBrowser` 是副作用，不靠 systemMessage 渲染）。

### 修复
- 进度/提示全部改走 **stderr + 日志文件**（不再污染 stdout）。
- 装完 Bun 后，把「✅ 已自动安装 Bun」提示与 hook 产出的 Dashboard 链接**合并成一条 `systemMessage`** 发 stdout（单 JSON、可解析）——`systemMessage` 是交互式 claude 一定会显示的字段，确保用户看到「装好了 + 链接」。
- 安装失败也发 `systemMessage`（不再静默）。

### 验证
Kali：隐藏 Bun 跑 SessionStart → stdout 为单条可解析 JSON `{"systemMessage":"✅ 已自动安装 Bun…\nShine Dashboard: …"}`，stderr 有 npm 进度；bun 在时走原 inherit 路径不变。

## 0.2.8 — 2026-07-07

修源码模式（`/plugin install`）首次 SessionStart 不打印 Dashboard 链接、得重启一次才出的问题。

### 修复
- `HEALTH_POLL_TIMEOUT_MS` 5000 → 15000。源码模式首次 SessionStart 要冷启动 daemon（`bun run` 首次 transpile TS + 加载 react/sqlite）可能 >5s；`ensureDaemon` 等不到 ready → `readToken` 空 → hook 跳过链接打印。提到 15s 覆盖冷启动（warm 启动 `isOursAlive` 立即命中，不会真等满）。

### 验证
Kali：杀掉 daemon 冷启动，跑一次 SessionStart →（bun 缺失时）提示 + 安装进度 + ✅ + Dashboard 链接一次全出（7s），不用再重启。

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
