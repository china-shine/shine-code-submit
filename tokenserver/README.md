# tokenserver

接收 [shine-worklog](../) daemon 报表上报的服务，按 **用户 → 项目 → token 详情** 三级展示。

## 简介

shine-worklog daemon 的 `reportUrl` 指向本服务。daemon 定时（每 `reportIntervalMin` 分钟）或手动（dashboard「上报」按钮）POST `ReportResponse`（含 gitUser/projects/sessions/token + gitCommits/git_changes + worklogs/禅道工时）到这里，本服务存储并按三级单页面展示。

- **后端**：bun + bun:sqlite（无外部依赖）
- **前端**：React + TSX（组件化，bun build 打包内联）
- **端口**：36667

## 功能

- 接收上报：`POST /api/report`（gzip 兼容，增量快照 + 24h 全量校准，upsert 入库）
- 三级展示：用户（成员列表）→ 项目（二级导航）→ 会话表格（三级，与报表结构一致）
- **AI 代码占比**：总览 7 张 KPI 卡之一（分子 ΣaiAdded / 分母 Σadded+deleted，只统计有 transcript 覆盖的 commit），点「分母」看按项目构成；可选 `aiStatsHosts` host 白名单过滤（见「运行配置」）
- **禅道工时**：成员详情「禅道工时」表（daemon 随报表 worklogs 上报的长期台账，任务名可点跳禅道）
- **成员客户端版本号**：成员列表展示各成员上报的 shine-worklog 版本号
- token 口径同报表：`rawTotal = input + output + cacheCreation + cacheRead`，四字段分别落列、SQL 直接 SUM

## 目录结构

```
tokenserver/
  package.json / tsconfig.json / .gitignore
  src/
    main.ts          # 入口
    server.ts        # HTTP 路由(API + 静态资源,双模式:开发读文件/编译内联)
    store.ts         # sqlite 存储 + 聚合(projects/sessions 两表 + 内存缓存)
    types.ts         # 上报数据类型(ReportResponse 等)
    ui-assets.ts     # UI 资源字符串(build 生成,编译时内联)
  ui/
    app.tsx          # React 入口
    index.html / style.css
    types.ts
    lib/{util,api}.ts
    components/      # App + common/ + overview/ + member/ + shell/（7 KPI 卡 / 排行 / 趋势 / 成员详情 / 禅道工时）
  scripts/
    build-ui.ts      # 仅打包 UI(开发用)
    build.ts         # 打包 Linux 二进制(UI + ui-assets + 编译)
  bin/               # 编译产物(gitignore)
  data/              # sqlite db(gitignore,运行时生成)
```

## 开发

```bash
cd tokenserver
bun install          # 装 react/react-dom(或复用宿主项目 node_modules)
bun run dev          # 启动开发服务 http://localhost:36667
```

改前端：
- 改 `ui/*.tsx` → `bun run build:ui` 重新打包 app.js → 刷新浏览器
- 改 `index.html` / `style.css` → 直接刷新（server 每次请求读文件，无需重启）

## 打包 Linux 二进制

```bash
bun run build        # 生成 bin/tokenserver-linux-x64(单文件,~90MB)
```

build 做三件事：
1. bundle `ui/app.tsx` → `ui/.build/app.js`
2. 生成 `src/ui-assets.ts`（HTML/JS/CSS 字符串化，编译时内联）
3. `bun build --compile --target bun-linux-x64` → `bin/tokenserver-linux-x64`

二进制内含 bun runtime + sqlite + React bundle，**单文件无外部依赖**，服务器不需装 bun/node。UI 资源已内联，运行时不需 `ui/` 目录。

## 部署到 Linux

```bash
# 1. 传二进制
scp tokenserver/bin/tokenserver-linux-x64 user@server:/opt/tokenserver/

# 2. 服务器上
ssh user@server
cd /opt/tokenserver
chmod +x tokenserver-linux-x64

# 3. 后台运行(data/ 目录自动建在二进制旁,需可写)
nohup ./tokenserver-linux-x64 > tokenserver.log 2>&1 &
nohup env PORT=8091 ./tokenserver-linux-x64 > tokenserver.log 2>&1 &

# 4. 放行端口(默认 36667)
sudo ufw allow 36667
```

访问 `http://服务器IP:36667/` 确认页面出来。

### systemd 托管（推荐长期运行）

```ini
# /etc/systemd/system/tokenserver.service
[Unit]
Description=tokenserver
After=network.target

[Service]
WorkingDirectory=/opt/tokenserver
ExecStart=/opt/tokenserver/tokenserver-linux-x64
Restart=always
Environment=PORT=36667

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tokenserver
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 36667 | 监听端口 |
| `TOKENSERVER_DATA_DIR` | 二进制旁 `data/` | sqlite db 目录；二进制目录只读时指向可写路径 |

**运行配置**（`TOKENSERVER_DATA_DIR/config.json`，手编辑）：`aiStatsHosts`（string[]，如 `["8.130.168.121"]`）——AI 占比只统计 `gitRemote` 命中指定 host 的 commit（公司 git 仓库），排除 localhost/个人/无 remote；空或未配 = 不过滤。改后重启生效。

## 配 daemon 上报

daemon **默认**已上报到 `http://47.98.221.20:36667/api/report`，间隔 10 分钟（见 `src/daemon/settings.ts` 的 `DEFAULTS`）。如需改地址，在 dashboard「设置」页改 `reportUrl`，或：

```bash
curl -X PUT http://127.0.0.1:36666/api/settings \
  -H "Authorization: Bearer <daemon-token>" \
  -d '{"reportUrl":"http://服务器IP:36667/api/report"}'
```

之后 daemon 每 `reportIntervalMin` 分钟（默认 10）自动上报，也可手动点 dashboard「上报」按钮触发。

## API

- `GET /api/health` — 健康检查（无鉴权）
- `POST /api/report` — daemon 上报（gzip 兼容），body = `ReportResponse` JSON（增量快照 + 全量校准，upsert 入库）
- `GET /api/stats?start=&end=&members=&granularity=` — 全局聚合（7 KPI / 趋势 / 排行 / 成员列表），供 overview
- `GET /api/sessions?start=&end=&members=&member=&page=&pageSize=` — 会话明细分页（翻页查 DB）
- `GET /api/denominator-breakdown?start=&end=&members=&member=` — AI 占比分母构成（按项目 / 按有无 AI）
- `GET /api/member/:gitUser?start=&end=&granularity=` — 单成员 KPI + 趋势（成员详情）
- `GET /api/member/:gitUser/worklog?start=&end=&page=&pageSize=` — 单成员禅道工时台账（日期字符串比较分页）
- `GET /` — 单页 UI（app.js/style.css 走 gzip + ETag）

> ⚠️ `POST /api/report` 当前无鉴权，局域网/本地用没问题；公网暴露前建议加 token 校验。

## 数据模型

规范化 4 表，upsert 去重（行数稳定，不随上报次数增长）：

```sql
projects(gitUser, cwd, name, gitRemote, lastActive, updatedAt, version)   -- PK(gitUser, cwd)
sessions(sessionId, gitUser, cwd, lastActive,
         input, output, cacheCreation, cacheRead,
         added, deleted, modified, activeMs, title, updatedAt)          -- PK(sessionId)
git_changes(hash, gitUser, cwd, ts, added, deleted, aiAdded)             -- PK(hash)
worklogs(gitUser, date, sessionId, taskId, subId, repo, branch, cwd,
         start, end, minutes, hours, taskName, projectId,
         projectName, work, status, zentaoUrl, updatedAt)   -- PK(gitUser,date,sessionId,taskId,subId)
```

- 上报时拆分逐条 upsert：项目按 `(gitUser, cwd)` 去重，会话按 `sessionId` 去重（仅 `lastActive >= 旧` 时覆盖 token，取最新快照）
- token 拆成 4 个整数列（`input/output/cacheCreation/cacheRead`），SQL 可直接 SUM；另存代码行 / `activeMs` / `title`
- `git_changes` 按 commit hash 去重（`aiAdded` 取 MAX，嵌套项目重复上报不膨胀）——AI 占比分母
- `worklogs` 按 `(gitUser,date,sessionId,taskId,subId)` 复合 upsert 累积（daemon 每次全量发提交流水 `submitted/<date>.jsonl`，`subId=<date>:<行号>` 使同会话同任务多笔提交各占一行）——禅道工时台账，逐笔镜像禅道记录
- 聚合查询（`getStats` / `getMember`）实时算，`getSessions` 走 LIMIT/OFFSET；前端不再有全量拉取，所有响应大小不随会话数膨胀

上报是**增量快照**：daemon 按 `lastReportAt` 水位只发 `last_activity >= 水位` 的 session，成功推进水位；每 24h 或手动触发一次 `since=0` 全量校准（含 daemon 升级后的 gitCommits 全量回填）。服务端 upsert 幂等，天然兼容增量/全量两种。

## token 口径

与 shine-worklog 报表完全一致（更细口径见 `数据说明.md`）：

- **显示总量 `rawTotal`** = `input + output + cacheCreation + cacheRead`（直接累加 Anthropic API 原始字段，不乘系数；早期「真实输入 = input + cacheCreation×1.25 + cacheRead×0.1」计费口径已弃用）
- **四字段分别落列**（sessions 表 `input/output/cacheCreation/cacheRead`），SQL 直接 SUM
- **fmtTokens**：k/M 一位小数，B/T 两位小数（`1.03e9` → `1.03B`）
- **详情显示**：`输入 X · 输出 Y · 总数 Z`（带文字标签）

## AI 代码占比

占比 = AI 代码行 / git commit 代码变化行，只统计**有 transcript 覆盖的 commit**（`aiAdded>0`）。详见 `数据说明.md` §9 与主项目 README「AI 代码占比 + 禅道工时台账」。
