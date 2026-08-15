# 06 Skills 子系统(skills/,含 zentao.ts 命令参考)

## 结构

每个 skill = 一个目录的 `SKILL.md`(给 AI 的执行指令)+ 共用脚本 `skills/report/scripts/zentao.ts`。**skills 层零 npm 依赖**(只 node: 内置),因为要在用户机裸跑。

| Skill | 作用 |
|---|---|
| `/report` | 工时填报主流程(plan→归纳→render→确认→commit) |
| `/prepare` | 提前算好 work+task 写 summary,让 /report 秒级 |
| `/daily` `/weekly` `/lastweek` | 日报/周报/上周周报(数据=禅道 efforts,HTML 落盘 reports/) |
| `/refresh` | 全量刷新禅道缓存 |
| `/setup` | 配禅道连接(url/account/password)+ 选常用项目 |
| `/amend` | 修正最后一次提交(禅道只能追加,补差额) |
| `/mark` | AI 提交标识配置(开关+文案) |
| `/mappings` | 仓库→项目映射缓存维护 |

## zentao.ts 命令参考(核心脚本)

调用约定:**绝对路径 + 当前项目目录下执行**(靠 `process.cwd()` 识别项目);已 cd 加 `--cwd "$PWD"`。共 23 个命令(上表全量)。

| 命令 | 作用 | 关键输出 |
|---|---|---|
| `check` | 验证禅道登录与身份 | account/realname |
| `projects [--all] [--search]` | 项目列表(默认只看进行中 left>0) | [{id,name}] |
| `my-tasks [--all-status]` | 我的任务(默认 doing/wait) | 任务列表 |
| `executions` | 进行中执行 | 供 create-task 选 |
| `create-task --execution --name --estimate --desc` | 建任务并指派自己 | 自动进缓存 |
| `refresh` | 全量刷缓存(20 天窗口,进度走 stderr) | {fetchedAt,projects,tasks} |
| `collect [--session]` | 从 daemon 拉当日会话写 sessions.json | 会话数 |
| `config` | 写禅道连接配置(url/account/password) | — |
| `mark` | AI 提交标识配置(开关/文案,等同 /mark skill) | — |
| `efforts` | 查某任务工时记录 | 记录列表 |
| `prepare` | 读 transcript 信号供 AI 归纳 | prompts/files/recent |
| `plan [--source zentao]` | ★ 生成 plan.json(读 sessions+summary+submitted,防重+冷却预判) | items+cooldown |
| `note --session --work --task` | ★ 写 summary(work+task+水位) | — |
| `render` | ★ 工时草稿文本(逐条分行编号;有 pending/缺 work 会 die) | 草稿 |
| `commit [--dry-run]` | ★ 逐条提交禅道+写水位+流水镜像 | results+mappings |
| `amend` | 修正最后一次提交(禅道只能追加,补差额;独立命令) | — |
| `submit --task --date --hours --work` | 手工单条提交(计划外修正) | — |
| `auto [--dry-run]` | collect→plan→(全 resolved)commit 一键 | action 分支 |
| `daily/weekly/lastweek --source cache\|zentao` | ★ 报表(stdout JSON:text/file/pendingTasks/dashboardUrl/autoRefreshed) | HTML 落盘 |
| `learn` | 学习仓库→项目映射 | — |
| `mappings` | 查看/维护映射缓存(列表/新增/修改/删除,等同 /mappings skill) | 映射表 |

★ = /report /daily /weekly 主链路。

## lib 四模块

- **shared.ts**:路径常量(`DATA_DIR/zenpilot/...`,与 src/shared/paths.ts 内联复刻、改动两边同步)+ helpers(roundPy 银行家舍入/hoursFromMinutes 向上取 0.5h/applyMark·isAiWork 标识三件套/**writeJSON 原子写** tmp+rename);
- **client.ts**:禅道 REST v1 客户端(三分错误:网络 die/HTTP throw 供重试/2xx→JSON;新请求体失败自动降级 legacy)+ **getCache 缓存层**(20 天滚动窗口,见 10-mechanisms);
- **transcript.ts**:collect(daemon /api/sessions → sessions.json)+ transcript 信号提取;
- **report.ts**:日报/周报装配(gatherReport 纯数据)+ HTML/文本渲染(worksHtml:`\n`→`<br>`;renderReportText 逐条分行)+ **报表侧按需刷新**(cacheStaleVsSubmissions 检测,1.3.46)。

## 修改注意

- **skills/ 不在 tsconfig**——typecheck 抓不到,改函数签名必须全局 grep 调用方(1.3.41 曾漏 zentao.ts 两处);
- 测试:`skills/report/scripts/__tests__/`,bun test;子进程 runner(plan-runner/commit-runner)用 env `LOCALAPPDATA` 指向临时目录做真隔离;
- SKILL.md 的措辞就是 AI 的执行逻辑(如「完整展示工时记录(硬性要求)」),改流程常改 SKILL 而非代码。
