# 06 Skills 子系统(skills/,含 zentao.ts 命令参考)

[← 手册索引](README.md)

## 结构

每个 skill = 一个目录的 `SKILL.md`(给 AI 的执行指令)+ 共用脚本 `skills/report/scripts/zentao.ts`。**skills 层零 npm 依赖**(只 node: 内置),因为要在用户机裸跑。

| Skill | 作用 |
|---|---|
| `/report` | 工时填报主流程(plan→render→确认→commit;全 resolved 时 work 原样提交不归纳——auto-note 文案即总结,归纳仅在 work 异常/用户要求时,严禁为写文案考古;增量条目 work=水位后全部 note 合并,多行是预期产物不是拼接异常;**note 超 10 行被折叠成「…(更早 N 条略)」时,plan 条目附 `incrementAllLines` 全部行,AI 归纳成 ≤6 行总结替换 work,折叠标记不进禅道**;work 异常快修=凭上下文直接 Edit plan.json,勿照过时的会话标题写;**点名日期(如「报昨天的工时」)不走 auto,render 后逐条核对归属日([补 MM-DD] 标记),与点名不符的确认前指出——跨天会话整体归最后活跃日,在昨天会话里说「报昨天」会整条落今天**;**报工时动作本身占用的时间不计入工时**:plan 聚合的「执行 shine-worklog 工时填报流程」条目(识别:work 固定文案/reason 含「填报流程会话自动聚合」)分步流程第 3 步删掉、auto 已内置排除 |
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
| `collect [--session]` | 从 daemon 拉会话写 sessions.json(范围=自上次提交日以来含今天,上限 14 天);hook 模式尾部顺带 **auto-note** 自动归纳(见 10-mechanisms ⑪,零 LLM) | 会话数 |
| `config` | 写禅道连接配置(url/account/password) | — |
| `mark` | AI 提交标识配置(开关/文案,等同 /mark skill) | — |
| `efforts` | 查某任务工时记录 | 记录列表 |
| `prepare` | 读 transcript 信号供 AI 归纳 | prompts/files/recent |
| `plan [--source zentao]` | ★ 生成 plan.json(读 sessions+summary+submitted,防重+冷却预判;条目带 `date`=会话归属日,多天补报按此提交;填报流程元会话同日自动聚合一条、时间轴去重——**但聚合条不计入工时**:分步流程 SKILL 第 3 步删除、auto 内置排除(cmdAuto 过滤 meta 并回写 plan.json),报工时动作占用的时间不进禅道/台账;**已提交(delta<15)条目不进 items,仅 alreadyCount 计数**——流程任何环节不复述已提交) | items+alreadyCount+cooldown |
| `note --session --work --task` | ★ 写 summary(work+task+水位) | — |
| `render` | ★ 工时草稿文本(逐条分行编号;增量条目显示「新增 Nmin」消歧——时间窗为全会话、工时只算水位后增量;有 pending/缺 work 会 die;无可提交条目时输出提示行) | 草稿 |
| `commit [--dry-run]` | ★ 逐条提交禅道+写水位+流水镜像 | results+mappings |
| `amend` | 修正最后一次提交(禅道只能追加,补差额;独立命令) | — |
| `submit --task --date --hours --work` | 手工单条提交(计划外修正) | — |
| `auto [--dry-run]` | collect→plan→(全 resolved)commit 一键(已排除填报流程会话——报工时时间不计入,见 plan 行) | action 分支 |
| `daily` / `weekly` / `lastweek` | ★ 报表(公共参数 `--source cache 或 zentao`;stdout JSON:text/file/pendingTasks/dashboardUrl/autoRefreshed) | HTML 落盘 |
| `learn` | 学习仓库→项目映射 | — |
| `mappings` | 查看/维护映射缓存(列表/新增/修改/删除,等同 /mappings skill) | 映射表 |

★ = /report /daily /weekly 主链路。

## lib 四模块

- **shared.ts**:路径常量(`DATA_DIR/zenpilot/...`,与 src/shared/paths.ts 内联复刻、改动两边同步)+ helpers(roundPy 银行家舍入/hoursFromMinutes 向上取 0.5h/applyMark·isAiWork 标识三件套/**writeJSON 原子写** tmp+rename);
- **client.ts**:禅道 REST v1 客户端(三分错误:网络 die/**HTTP 非 2xx throw 供重试/2xx→JSON**;错误挂结构化 `status`(2026-08-20):`submitEffort`/`createTask` 的 catch **只对 HTTP 非 2xx 降级 legacy**(旧版禅道对新 body 返回 500)、**2xx 但响应非 JSON 一律 rethrow 防双写**——服务器已成功记录但响应不可解析时绝不重发)+ **getCache 缓存层**(20 天滚动窗口,见 10-mechanisms);
- **transcript.ts**:collect(daemon /api/sessions → sessions.json,自上次提交日以来多天范围)+ transcript 信号提取;
- **report.ts**:日报/周报装配(gatherReport 纯数据)+ HTML/文本渲染(worksHtml:`\n`→`<br>`;renderReportText 逐条分行)+ **报表侧按需刷新**(cacheStaleVsSubmissions 检测,1.3.46)。

## 修改注意

- **skills/ 不在 tsconfig**——typecheck 抓不到,改函数签名必须全局 grep 调用方(1.3.41 曾漏 zentao.ts 两处);
- **dashboard「Skills」模块可直接编辑 skills/ 的 Markdown 文档**(GET/PUT /api/skills/file,写当前生效插件根的 skills/,仅 `.md`——.ts 代码不开放,走源码仓库改):保存落盘即时(无需发版/重装),**但 skill 指令内容在 Claude Code 会话启动时加载——已开会话跑 `/reload-skills` 重载(或重进会话)才生效**(2026-08-19 用户实测定口径;官方文档 [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)「Live change detection」确认热重载仅 watch `~/.claude/skills/`、项目 `.claude/skills/`、`--add-dir` 三处,插件 cache 目录不在范围——非 bug 是设计;skill 的 scripts 如 zentao.ts 是每次调用从磁盘跑、不受此限);升级插件版本后同理:会话的 skill Base directory 钉在启动时的版本目录,/reload-skills 或重进才切到新目录。编辑器为 Monaco(VS Code 内核,markdown 高亮+查找/折叠/多光标),tab 按近 7 天使用频率降序、默认开最高频,Ctrl/Cmd+S 快捷保存;「重置」把文件恢复到**当前版本**首次编辑前的原始内容(备份 `original` 基线,按版本目录独立捕获;**不变量:只要不修改,实时 skills 恒等于当前安装版本自带内容**——升级整目录覆盖自动重置,重置只认当前版本基线,旧版本备份不作重置来源,当前版本无备份即磁盘=出厂内容报错提示);autoUpdate 升级/`install --force` 整目录覆盖会冲掉本地编辑——保存时自动备份到 `DATA_DIR/skills-edits/`(不自动重放);源码模式下编辑即改仓库文件(git 兜底)。试验稳定后应「复制」拷回仓库 skills/ 随下版发布;monaco-editor 只进 devDependencies(本机构建用,发布物不带);模块顶部有**「实时 skills / 备份 skills」双 tab**:实时=执行目录的**纯净编辑器**——完全以当前插件版本(磁盘)为准,不做 stale/本地编辑任何提示(2026-08-18 定:升级后磁盘是什么就编辑什么);**备份=编辑留痕浏览**(GET /api/skills/edits 分组列表,每文件 tab 带版本徽标,●=磁盘与最新备份不一致即被升级覆盖),内容只读展示,可按保存点切换(同版本留最近 20 次 history 快照)、**⇄ 对比实时**(Monaco DiffEditor,左=备份右=磁盘,升级后搬改动看差异高亮)、复制片段(切回实时 tab 粘贴保存)或「⬇ 恢复到实时」一键把选中快照写回执行目录(POST /api/skills/restore 带 savedAt,恢复也落新备份);确认弹窗全模块统一为通用 React 模态(重置/恢复/放弃未保存/覆盖外部修改四场景),Ctrl+S 仅实时视图生效;备份落盘为 `DATA_DIR/skills-edits/`(按插件版本分目录,每份备份旁有可读 `md/<rel>` 镜像,磁盘上直接可读可拷);
- 测试:`skills/report/scripts/__tests__/`,bun test;两类:
  - **CLI 端到端**(cli-local/cli-net/cli-report + cli-harness 基建):mock 禅道(Bun.serve port 0)+ 子进程真跑 `zentao.ts`(LOCALAPPDATA→tmp + `--cwd`→tmp 双隔离),覆盖全部 23 个命令的成功/die 分支;mock 记录请求供「参数正确/未发请求」断言。collect 的 daemon 可达分支(127.0.0.1:36666 硬编码)与 auto 的 abort 分支无法注入,已注明;
  - **子进程 runner**(plan-runner/commit-runner/attribution-runner):env `LOCALAPPDATA` 指临时目录做真隔离,直接调 cmdPlan/cmdCommit 函数级深测;attribution-runner 专测归属日机制(所有本地时间运算在 runner 侧做,规避 bun test TZ=UTC 差 8h)——独立昨天会话归昨天、跨天会话(lastActive=今早)整体归今天,已随 1.4.7 测试固化;
- SKILL.md 的措辞就是 AI 的执行逻辑(如「完整展示工时记录(硬性要求)」),改流程常改 SKILL 而非代码。
