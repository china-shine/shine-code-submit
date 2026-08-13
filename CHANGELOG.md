# 更新日志

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.3.33 — 2026-08-13

修复 AI 代码占比假性偏低:分子补 aiDeleted,与分母对称。

### 修复
- **AI 占比分子分母不对称**:tokenserver AI 代码占比分母=Σ(added+deleted),但分子只算 aiAdded(deleted 恒 0)→ AI 每删一行旧代码(重构)分母 +1 分子 +0,占比被稀释(全程 AI 写代码也只有 ~70%)。修复:分子改为 Σ(aiAdded+aiDeleted),daemon `aggregate.ts` 补 aiDeleted 行级匹配(`getProjectAILines` 早已把删除行存进集合,数据现成),tokenserver 全链路(建表/迁移/upsert/聚合 getStats+getMember+getDenominatorBreakdown)接 aiDeleted 到分子。前端早已按 added+deleted 对称写好,无需改动。
- ⚠️ **历史数据需回填**:`git_changes` 旧记录 aiDeleted=0(增量上报不重发旧 commit),修复后新 commit 自动带 aiDeleted;旧数据需触发 daemon 全量重报(删 settings.lastReportAt 或 POST /api/report/upload?full=1)回填。

## 1.3.32 — 2026-08-12

日报/周报增加工时确认步骤（1.3.31 本地测试通过，正式发布）。

### 变更
- **确认步骤**:daily/weekly/lastweek 脚本跑完后先完整展示 text（每个任务每天的工时明细与工作内容），用户确认无误后再 AI 排版+总结；不对可重试（refresh 刷新缓存重新拉）。

## 1.3.31 — 2026-08-12

日报/周报增加工时确认步骤：生成后先展示完整明细让用户确认，避免禅道 efforts 缺失。

### 变更
- **确认步骤**:daily/weekly/lastweek 步骤2 增加确认——脚本跑完后先完整展示 text（每个任务每天的工时明细与工作内容），用户确认无误后再 AI 排版+总结；工时不对可点重试（refresh 刷新缓存重新拉）。
- 解决禅道网络波动导致 efforts 缺失的问题：第2次报 31.5h 第1次只报 25.5h（少了 dify 6h），确认步骤让用户一眼发现再重试。

## 1.3.29 — 2026-08-12

强化日报/周报 AI 排版规则：内容不动、只改排版。

### 变更
- **排版规则强化**:SKILL 排版首条改为「只改排版、不改内容」（总原则）。禅道原文的每一个字、数字、符号、代码全部原样保留（不转换不替换不删除不增加），只动标点（半角→全角）和空格（中英文间加空格）。避免之前 AI 排版时把 `\n` 等技术字符串误转成可读文字。

## 1.3.26 — 2026-08-12

daemon 自动重启 + SessionStart 清理保留 5 个版本（1.3.16 regression 彻底修复）。

### 修复
- **daemon 进程自动重启**:autoUpdate 升级 cache 后 daemon 旧进程自动重启(跑新代码)。startDaemonWithBun 用 `pid.startedAt vs .install-version.installedAt` 判断进程新旧(替代恒相等的 version 比较)。1.3.16 已撤销的 fix 基于 1.3.17 重做 + 7 轮本地测试通过(daemon 每次重启 pid 变 + token 持久)。
- **SessionStart 清理保留 5 个版本**:清理旧版本 cache 目录时保留最新 5 个(semver 排序),删更早的;少于 5 个不删。避免多会话升级时旧会话锁定的版本被删致 hook MODULE_NOT_FOUND(1.3.16 regression 根因)。业界 Squirrel/Electron 同款思路(保留 N 个旧版本)。

## 1.3.20 — 2026-08-12

修复 autoUpdate 升级 cache 后 daemon 进程不自动重启（1.3.16 已撤销的 fix 重做,基于 1.3.17）。

### 修复
- **daemon 进程重启判断**:startDaemonWithBun(install)原用 `probe.version === SERVICE_VERSION` 判断是否跳过启动,但 version 都读新 package.json(cache 换目录后 daemon health 也报新),恒相等 → daemon 旧进程不重启(跑旧代码)。改为 `version 同 && pid.startedAt >= cache.installedAt`(进程启动时间 vs cache 部署时间)双条件——daemon 启动于 cache 部署前(进程旧)则 stopDaemon + spawn 重启。新增 deploy.readInstallVersionMeta 读 .install-version 元数据。本地 3 轮测试通过(1.3.17→1.3.18→1.3.19→1.3.20,daemon 每次重启 pid 变 + token 持久)。

## 1.3.17 — 2026-08-12

回退 1.3.16（1.3.16 autoUpdate 升级时误删当前会话锁定的旧版本目录,导致 hook launcher.cjs 找不到 → Stop hook error）。1.3.17 回到 1.3.15 内容（稳定,无 regression）。daemon 自动重启 fix（startDaemonWithBun 用 startedAt vs installedAt 判断进程新旧）稍后基于 1.3.17 重做,确保不删当前会话锁定的旧目录。

## 1.3.15 — 2026-08-12

日报/周报生成流程打磨:报告脚本 stdout 直出 dashboard 链接、表格 work 排版交给 AI。

### 新增
- **报告脚本 stdout 直出 dashboard 链接**:weekly/daily/lastweek 输出增加 `dashboardUrl` 字段(读 daemon.pid 拼链接,daemon 未运行返回 null)。生成报告 = 单条命令拿全 HTML 路径 + dashboard 链接 + 待办任务,根除 SKILL.md 误用 zentao.ts ui 的「未知命令」报错。
- **表格 work 排版交给 AI**:report.ts 去掉 renumberWorks 渲染(脚本只放禅道原始 effort,worksHtml 去 `\r`),daily/weekly/lastweek SKILL 写 AI 智能排版要求——不管原文格式,AI 排成统一整洁(简单 work 合并、复杂【现象】【原因】【措施】按结构分块、全角标点 + 中英文空格、标识在末尾、内容保留)。

### 变更
- **周报下周计划**:据 pendingTasks 列下周要推进的任务,改为直接说下周做什么(任务名 + 具体动作),去掉 consumed/百分比/剩余 数字与进度状态词。
- **命令描述中文化**:9 个 slash 命令 description 去可避免英文(work→工作内容、task→任务、summary→工时记录、efforts 去冗余)、`Use when` 统一改成中文「当用户…时使用」。
- **残留 ZenPilot 改名 shine-worklog**:8 个 SKILL 标题、周报/日报 HTML 页脚、HTTP User-Agent、代码注释(ZENPILOT_HOME 数据目录与迁移/历史文档保留)。

## 1.3.14 — 2026-08-11

dashboard 顶部加手动「检查更新」按钮。

### 新增
- **手动检查更新**:dashboard 顶栏加「⤓ 检查更新」按钮,POST `/api/update`(`force`,不受 autoUpdate 开关限制)→ daemon 查 npm,有新版则 spawn install(VBS 隐藏无弹窗)+ daemon 自动重启。比 autoUpdate 60min tick 更即时,配合 Stop 升级提示(1.3.13)形成「发现新版 → 升级 → 提示重启」闭环。
- 按钮交互:检查中 spinner 旋转(文字始终显示不隐藏)、结果胶囊(成功绿/失败红/信息灰)固定停留不自动消失。

## 1.3.13 — 2026-08-11

修复 autoUpdate 升级打断当前 Claude Code 会话的问题(升级时旧目录被删 → hook 报错 + 旧 hook 把新 daemon 反复降级)。

### 修复
- **升级时不再立即删旧版本目录**:`install` 移除 `pruneOldVersions()` 调用——原升级即删旧目录,导致当前会话 hook 因旧目录消失而 `Plugin directory does not exist` error。改由 SessionStart hook 清理(Claude Code 启动时新会话已锁定新版,删 sibling 旧版本目录安全)。
- **forward 升级检测加方向判断**:原 `daemon version !== SERVICE_VERSION` 不分方向,autoUpdate 升 daemon 后,旧会话 hook 转发时会把新 daemon `stopDaemon + spawnDaemon` 降级回旧版(反复降级)。改为 `isNewer(SERVICE_VERSION, daemonVersion)`——仅 hook 新于 daemon 才重启 daemon(真正升级旧 daemon);daemon 新于 hook 时不动(等用户重启 Claude Code 让 hook 跟上)。

### 新增
- **Stop hook 升级提示**:autoUpdate 升级 daemon 后,当前会话 hook 仍跑旧版(Claude Code 会话锁定版本,不能热切)。Stop/SubagentStop hook 检测 daemon version 严格新于自己(semver 比较)→ 返回 `systemMessage` 温和提示「✨ 已升级到 vX,重启 Claude Code 后生效」。非 block、非 error(避开 #34600),每轮提示直到重启(重启后 daemon 版本重新等于 hook,提示自然消失)。

## 1.3.12 — 2026-08-11

README 与代码对齐 + launcher 日志路径统一到 DATA_DIR。

### 修复
- **launcher bun-install.log 路径统一到 DATA_DIR**:`bin/launcher.cjs` 的 `logFile()` 原硬编码 `~/.local/share/shine-worklog/log/`,Windows 上与数据目录(`%LOCALAPPDATA%/shine-worklog/`)分家;改为对齐 `src/shared/paths.ts` 的 DATA_DIR(Windows 用 `%LOCALAPPDATA%`)。

### 文档
- **README 目录树补 `skills/`**:原目录树漏列 `skills/` 目录(9 个 skill:`/report /prepare /daily /weekly /lastweek /amend /mappings /mark /setup`),补上。
- **README bun-install.log 路径泛化**:配合 launcher 改动,路径描述从写死的 `~/.local/share/shine-worklog/log/` 改为 `<DATA_DIR>/log/`(Win/mac/linux 分别注明)。

## 1.3.11 — 2026-08-11

修复新项目第一次 note 报错 + note 输出简洁。

### 修复
- **新项目第一次 note 不报错**:cmdNote 无 sessions.json + 无 CLAUDE_SESSION_ID env 时记 session=null(不再 die);cmdPlan 把 session=null 的 note 归到当天最新 session。之前新文件夹第一次写代码记 note 会报「无当天会话数据」(因为 sessions.json 要等 Stop 才采集,note 在响应中段跑读不到)。
- **note 输出简洁**:成功只显示「✓ 工时已记录:<work>」一行,不输出 JSON(减少对话杂乱)。
- SessionStart 加 forkZenCollect 早采集;inferProjectTask 签名接受 string|null|undefined。

## 1.3.10 — 2026-08-11

修复提示词 note 命令路径(非 livesetting 项目 command not found)。

### 修复
- **note 命令绝对路径**:UserPromptSubmit 提示词的 note 命令从相对路径(`skills/report/scripts/zentao.ts`,只在 livesetting 源码目录有效)改为用 `CLAUDE_PLUGIN_ROOT` 拼绝对路径。之前在其他项目/目录(如 temp/aaa)AI 跑会 `command not found`(找不到 skills/...,AI 还简化成裸 note);现在任何 cwd/项目都能直接跑。

## 1.3.9 — 2026-08-11

提示词加强措辞,提高 AI 记 note 的遵循率。

### 改动
- **提示词加强**:UserPromptSubmit 每轮提示词从中性措辞("若有...就...")改为强指令("一旦...【必须】...不得遗漏"),提高 AI 记 note 的执行率(尤其 helloworld 这类简单任务完成后)。本质仍是提醒(非强制),复杂任务 AI 可能仍忽略。

## 1.3.8 — 2026-08-11

回退 1.3.7 的 Stop 强制记 note(Stop block 在 Claude Code 必然显示 "Stop hook error",无法避免)。

### 改动
- **回退 Stop 强制**:去掉 1.3.7 的 Stop hook block(本轮有代码改动未记 note → block)。原因:Stop block 在 Claude Code 必然显示 "Stop hook error"(issue [#34600](https://github.com/anthropics/claude-code/issues/34600),exit 0 + JSON decision:block 亦然),用户不接受 error 显示。
- **恢复纯提示词**:note 记录靠 UserPromptSubmit 每轮提示词提醒 AI 自觉(不强制,但无 error)。
- 去掉 lastTurnToolUses / lastTurnHasCodeChange / lastTurnHasNote 三个检测函数。

## 1.3.7 — 2026-08-11

Stop hook 强制记 note:本轮有代码改动(新建/编辑文件)但未记 note 时 block,补上"提示词自觉"路线的兜底。

### 改动
- **Stop 强制记 note**:响应结束(Stop)时,若本轮有 Write/Edit/MultiEdit 且未跑 note → block 让 AI 补记。解决"提示词提醒但 AI 忽略不记"(如 helloworld 场景)。
- **避免 stop error**:用 exit 0 + JSON `{decision:block,reason}`(而非 exit 2),block 显示为柔和提示,不是红色 "Stop hook error"。
- **防死循环**:lastTurnHasNote 检测本轮已跑过 `zentao.ts note` → 记过就不再 block;AI 记完 note(Bash)再次 Stop 时正常退出。

## 1.3.6 — 2026-08-11

UserPromptSubmit 提示词明确"代码改动"定义。

### 改动
- **提示词明确代码改动**:hook 注入的每轮提示词把"代码改动"明确为"新建/编辑/删除文件",防 AI 把写新文件(如 helloworld)误判成"不算代码改动"而不记 note。

## 1.3.5 — 2026-08-10

note 工时记录机制重构:每轮提示词驱动完成后记 + task 不确定记 -1 + /report unmatched 集中匹配统一提交。

### 改动
- **note 触发机制**:删除中间每轮的 ≥30min 未记兜底提醒,简化为每轮 UserPromptSubmit 注入基础提示词(本轮有代码改动→完成后记,task 不确定记 -1,不跳过不问)。
- **task=-1 无感记录**:cmdNote --task 可省/传 -1(找不到任务不跳过不问);/report 时 task=-1 的 note 标 unmatched(带候选)集中匹配。
- **/report unmatched 统一提交**:task>0 先就绪,task=-1 集中匹配候选后一次统一提交(避开 30min 二次冷却)。
- **cmdNote inferProjectTask**:task≤0 自动沿用项目历史关联任务(防 AI 偷懒传 -1 丢失已关联项目归属)。
- **increment 沿用原 task**:已提交会话增量补报沿用原 task(-1=不确定,用会话已知归属)。

### 修复
- cmdPlan 碎 note 拆段工时膨胀:每段 0.5h 下限累加 >> 整 session → 检测后合并单 item 取整 session 工时。
- cmdNote --task 非数字归 -1(防 NaN 写进 summary)。
- cmdAuto/cmdRender/cmdCommit 的 pending session 去重。
- candidatesFor 抽出复用(needs_semantic + unmatched)。

## 1.3.4 — 2026-08-07

禅道工时 AI 提交标识(可配置开关+文案):提交时标注、报告对账统计 AI 代报。

### 改动
- **AI 提交标识**:/report 提交禅道工时时在 work 末尾追加标识行(默认「本次内容由AI填报」,独立一行);/daily /weekly 据此对账统计「AI 代报 N h」(hero chip + 合计行);renumberWorks 渲染时自动剥掉标识行、不计入工作内容编号。标识随禅道 effort 走,不依赖本地台账(重装/补报不丢)。
- **三处可配**:新增 `mark` 子命令(`--on/--off/--text/--show`)+ `/shine-worklog:mark` skill + dashboard 设置页「AI 提交标识」区块,均读写 settings.json 的 `aiSubmitMark:{enabled,text}`,默认开启。
- **后端**:Settings 接口 + DEFAULTS 加 aiSubmitMark;PUT /api/settings 加嵌套对象合并分支。

## 1.3.3 — 2026-08-06

禅道工时填报闭环 + zentao.ts 拆分重构与单测 + dashboard 禅道/日报周报模块。

### 改动
- **工时填报闭环**:开发时 note 记 summary → /report 直读提交;/prepare 提前批量准备;Stop hook 对话结束自动记;多 note 按水位拆工时到各 task。
- **work 总结性**:note 记一句话结论,/report AI 综合成 3-5 条总结(非功能点流水账)。
- **branchToTask + 匹配失败选项**:手动分支→任务映射接进 plan;匹配失败可更新缓存/建任务/选候选。
- **缓存本地优先 + TTL**:提交工时只读本地缓存,仅 TTL 过期或手动才拉禅道。
- **跨午夜工时修复**:submitted/summary 按 session 跨日期聚合,修长会话跨夜丢工时。
- **zentao.ts 拆分 + 单测**:1935→775 行拆 4 模块,清死代码 -170 行,补 91 例单测。
- **dashboard 禅道/日报周报模块**:禅道任务/项目查看;日报周报从 efforts 汇总生成 HTML + AI 日/周总结;设置页配禅道账号。
- **日报周报静态预览**:daemon 加 /reports/?t= 静态端点,预览改 HTTP URL(免 blob)。
- **字色提亮**:--text/--muted 提亮增对比。

## 1.3.2 — 2026-08-03

日报/周报工作内容编号跨多次提交顺延,不再重复。

### 改动
- **日报/周报 work 编号顺延**:同一天/周对同一任务多次提交工时时,各次 work 各自从「1.」开始编号,聚合后出现多个重复的 1./2.。新增 `renumberWorks`(skills/report/scripts/zentao.ts):把同任务多次提交的 work 条目拆出、去原编号、统一重新 1..N 顺延。日报 HTML 表格、周报 HTML 表格、纯文本摘要三处渲染统一改用此函数。

## 1.3.1 — 2026-08-03

tokenserver 成员详情新增「禅道工时」表(禅道工时接入 report 上报链路)+ install 无条件清旧插件 + dashboard 链接网卡 fix。

### 改动
- **tokenserver 成员详情新增「禅道工时」表**:禅道工时原与 token 上报物理隔离(只躺本地 `plan.json`、只存当天),本次新建上报链路让其进 tokenserver 数据库长期台账。daemon 新增 `worklog.ts`(`collectWorklogs` 读 `zenpilot/projects/*/plan.json` 的 `status=resolved` 条目,带 zentaoUrl)填入 `ReportResponse.worklogs`(忽略 since 增量水位,每次全量读);tokenserver 新增 `worklogs` 表(PK `gitUser,date,sessionId,taskId` 复合 upsert 累积)+ `GET /api/member/:gitUser/worklog`(日期字符串比较分页,注册在 `/api/member/:gitUser` 前缀路由之上);前端 `MemberDetailPage` 新增 `WorklogTable`(4 列对齐周报:日期 / 任务#ID / 工时 / 工作内容,任务名可点跳禅道,服务端分页 10/页)。
- **install 无条件反注册旧插件**:`cleanupOldPlugin`(删旧 `shine-code-submit` cache + 清三个注册 JSON 旧 key)原只在 `migrateLayout` 条件触发(需有旧 DATA_DIR),"只装过插件没跑过 daemon"的用户旧插件会残留。改为 `runInstall` 无条件调用(幂等,无旧则跳过),保证每次 install 后 `/plugin` 不残留旧插件。配合 `shine-code-submit` npm 全版本 deprecate 改名提示,存量用户一条 `npx shine-worklog install` 即可平滑切换。
- **dashboard 链接网卡 fix**:`getPrimaryIpv4` 误取 Clash TUN 网卡(198.18.0.1)致打印的 dashboard 链接局域网不可达,跳过该网段。
- 文档:README 展开 `zenpilot/` 目录说明(plan/sessions/submitted 写入模式 + 增长评估)、新增「三个目录:工作目录 / plugin cache / DATA_DIR」章节。

## 1.3.0 — 2026-08-03

改名 shine-code-submit → **shine-worklog** + 统一数据目录 + AI 占比 bugfix。

### 改动
- **改名 shine-worklog**:原名 submit 太窄(不涵盖禅道工时填报 + 观测)。包名/插件名/DATA_DIR/CLI/env 全改;install 时自动迁移旧 `shine-code-submit` 数据(rename DATA_DIR + ZenPilot 统一进 DATA_DIR/zenpilot)+ 反注册旧插件(避免双 hook)。
- **统一数据目录**:ZenPilot 数据从 `~/.zenpilot/` 挪到 `DATA_DIR/zenpilot/`,一个插件一个数据根。
- **AI 占比 bugfix**:`aggregate.ts` aiAdded 误含 deletedLines 致 >100%(96/789 commit),改为只计 addedLines(全局 9.4%→8.0%)。
- env `SHINE_CODE_SUBMIT_*` → `SHINE_WORKLOG_*`(读取处双名 fallback 兼容一代)。

## 1.2.0 — 2026-08-03

合并 ZenPilot(禅道工时填报)进本项目为单一插件。

### 改动
- skills(setup/report/amend/mappings/daily/weekly)+ zentao.ts 整体并入;`collect` 改读 daemon `/api/sessions`(不再挖 transcript,消除重复采集)。
- Stop hook fork zentao.ts collect 转发 stdin(解决 Claude Code Stop 单 stdin 争抢)。
- 工时口径用 daemon activeMs;`~/.zenpilot/` 当时保留独立(1.3.0 起统一进 DATA_DIR/zenpilot)。

## 1.1.13 — 2026-07-29

AI 代码占比改行级精确（transcript ∩ git）+ 按日 sparkline + 成员列表显示客户端版本号。

### 改动
- **AI 占比行级精确**:分子从 commit 标记(Co-Authored-By)改为行级内容匹配——daemon 从 transcript PostToolUse 的 structuredPatch 提取 AI 改动行(按文件,+/- 行都算),git log -p 采 commit 的 added/deleted 行内容,行内容相交算 aiAdded。认行不认 commit,添加/修改/删除都计入,手动 commit 的 AI 代码也能识别。新增 daemon `lines.ts`(`getProjectAILines`:项目级 AI 行集合 + 分页突破 query 2000 cap + GIT_CACHE_TTL 缓存、`normRelPath` 路径归一);shared types `CommitFile.addedLines/deletedLines`、`GitCommitStat.aiAdded`;tokenserver `git_changes` 加 `aiAdded` 列(ALTER 迁移)+ upsert `ON CONFLICT DO UPDATE SET aiAdded=MAX`(嵌套项目重复上报取较大);`getStats/getMember` 占比分子改 ΣaiAdded;前端占比分子改用 aiCodeLines。
- **AI 占比按日 sparkline**:总览占比卡 + 成员详情页展示 AI 占比按日趋势。
- **成员列表显示客户端版本号**:成员列表展示各成员客户端上报的 shine-code-submit 版本号。
- ⚠️ **数据格式变更**(tokenserver 与 daemon 须配套升级):`gitCommits` 每条新增 `aiAdded`。部署顺序**先 tokenserver 后 daemon**——旧 tokenserver 收新 daemon 上报会因 `aiAdded` 列不存在 SQL 报错;新 tokenserver + 旧 daemon 不报错但占比偏低。用户 daemon 升级到 1.1.13 并重启后,自动全量回填(since=0)历史 commit 的 aiAdded(依赖本次 bump version 触发,upsert MAX 幂等覆盖),无需手动 full。

## 1.1.12 — 2026-07-27

新增「AI 代码占比」指标 + 升级自动全量回填历史。

### 改动
- **AI 代码占比(tokenserver 新 KPI)**:占比 = AI 代码行 / git commit 代码变化行,cap 100% + 标「估算」。daemon `buildProjectDetail` 跑 `git log --since --numstat` 拉项目该窗口所有 commit(无状态 + commit hash 幂等),tokenserver 新增 `git_changes` 表落库,`getStats`/`getMember` 双表聚合;占比卡副标显示分子分母(直接数字)。详见 `tokenserver/数据说明.md` §9。
- **升级自动全量回填**:daemon 启动检测 `SERVICE_VERSION` 变化 → 重置 `lastFullReportAt=0` → 下次上报自动全量(`since=0`),回填本项目历史 gitCommits(无需手动 full)。依赖发版 bump version 触发。
- **大项目全量不超时/413**:上报超时 15s→60s;tokenserver `maxRequestBodySize` 256MB;`git log --max-count` 2000→10000。

## 1.1.11 — 2026-07-24

修复会话详情页 token 与会话列表/报表对不上的问题(详情页曾用简化口径,漏算子代理、不去重)。

### 改动
- **会话详情页 token 口径对齐**:`/api/transcript` 的 `tokenTotal` 从 `sumUsage(messages)`(只读父 transcript、对每条 usage 直接相加、不去重不校验)改为 `sumSessionUsage(tp)`——纳入 `subagents/*.jsonl` 并走 ccusage 的 messageId+requestId 去重 + null 黑名单 + 严格时间戳校验,与会话列表/报表/SQLite 同口径。此前凡用过 Task/Explore 等 subagent 的会话,详情页都少算一大块;有重放/重试行的会话又会多算。
- **详情页内部口径统一**:`Conversation` 底部「本会话累计」改用后端透传的会话级 `tokenTotal`,不再前端 `sumUsage(messages)` 重算,消除详情页顶部与底部分叉。

## 1.1.10 — 2026-07-23

修两个让 dashboard「少会话 / 刷屏」的问题。

### 改动
- **cwd 大小写归一**:hook 上报盘符偶发小写与正常大写严格相等比较不等,会把同一项目拆成两个 → 该项目会话「凭空少一个」。新增 normCwd(Win/Mac 大小写不敏感 + Win 统一斜杠),项目分组与 L2 过滤统一归一,合并后保留原始 cwd 显示。
- **清理已删/无父 transcript 残留**:文件删除后 SQLite 残留 dirty 记录,consumer 每 tick 重试 openSync 永久 ENOENT 刷屏。新增 deleteFile/deleteSession,ENOENT 清残留;recomputeSession 在文件全删或父 transcript 缺失(只剩孤儿子代理)时删 session,对齐 ccusage「无父不算 session」口径。
- **验证**:对拍 ccusage claude session,98/98 session 逐字段(input/output/cacheCreation/cacheRead)全等,全局 delta 全 0。

## 1.1.9 — 2026-07-23

报表上报 UI 优化。

### 改动
- **报表上报区分增量/全量**:两个按钮(增量 ☁ 只发变化 session / 全量 ☁☁ 强制发所有,出问题时手动全量重锚)。`/api/report/upload` 加 `?full` 参数。
- **上报按钮抽到独立工具栏**:panel-header(标题+汇总)+ report-toolbar(刷新+增量+全量+结果)分离。
- **按钮醒目 + 固定宽度**:刷新/上报按钮 accent 实色;三个按钮 `width: 7rem` 固定 + 结果区固定占位,上报中/完成按钮位置宽度不抖动。

## 1.1.8 — 2026-07-23

transcript 性能架构升级:SQLite 数据中枢替代轮询 + 增量上报。

### 改动
- **SQLite 数据中枢(P1+P2+P3)**:watcher(fs.watch)监听 transcript 变化→标 SQLite dirty;消费者 2s tick 增量读尾部+全量算(算法不变,与 ccusage 字节级一致)→持久化 `transcript_files`/`transcript_sessions`;前端 API 改查 SQLite;5min 兜底全扫防漏。重启不重算(mtime 没变的 session 只读 SQLite),冷启动大幅降低;活跃 session 只读尾部增量。删除旧 `scanSessions`/`token-cache`/`infoCache` 轮询。
- **增量上报**:`settings.lastReportAt` 持久化水位,`buildReport(since)` 只发变化 session(tokenserver upsert 幂等不改)。失败不推进水位不丢。
- **定期全量校准**:`lastFullReportAt`,每 24h 强制全量一次,防 tokenserver 数据漂移。
- **性能**:transcript 解析读一次+合并 dedupe(单次 miss 成本 1/4);build:dist 跳过 exe build(纯源码分发)。
- **前端**:状态栏 `/api/stats` 改手动刷新(去 2s 自动轮询);favicon 返回 204(去浏览器 401)。
- **修复**:增量上报 gitUser 从全量补取(增量不再误判无身份);手动上报走全量。
- **验证**:97 session 全字段 + ccusage 直接对拍 97/97 字节级 PASS。

## 1.1.7 — 2026-07-23

升级时自动清理旧版本残留目录（daemon 运行确认后才删，绝不两头空）。

### 改动
- **部署后清理旧 version cache 目录**：每次 install/自动升级部署新版本到 `cache/shine-code-submit/shine-code-submit/<version>/` 后，删除非当前版本的 cache 目录及各自 `node_modules`，只保留当前版本——不再单靠 Claude Code `.last_inuse_sweep` 的不透明时机回收，避免旧版本目录长期堆积。
- **daemon 运行确认后才删（门控）**：`startDaemonWithBun` 返回就绪状态（probe `alive && version === 当前`），`runInstall` 仅在 `ready=true` 时调 `pruneOldVersions`。启动失败/超时则保留旧版可用，绝不出现「旧的已删、新的没装成」两头空。

## 1.1.6 — 2026-07-22

修复升级后 hook 仍跑旧代码的问题（marketplace 路径漂移）——这才是「升级后链接只在第一次显示」的真因。

### 改动
- **修 enablePlugin 路径漂移**：`register.ts` 的 `enablePlugin` 原逻辑只在「条目不存在」时写 `settings.json` 的 `extraKnownMarketplaces.shine-code-submit` path → 首次安装后，后续升级都不更新它，path 钉在首次安装的旧版本目录。Claude Code 按 `extraKnownMarketplaces` 加载 → hook 一直跑旧代码（链接只在首次/升级时显示）。改为**每次 install 无条件把 path 更新到当前版本 cachePath**（与 `registerMarketplace` 一致），杜绝漂移。
- 影响：已装用户被自动升级拉到 1.1.6 时，install 会自动把 path 修正到 1.1.6 目录，重启 Claude Code 后生效。

## 1.1.5 — 2026-07-22

每次打开 Claude 都显示 dashboard 链接（resume 也显示）。

### 改动
- **resume 也始终打链接**：SessionStart 块原仅 `source=startup` 始终打链接，`resume` 只在升级时打。改为 `startup` 与 `resume` 都每次打链接——用户无论全新启动还是 `claude -c` / `--resume` / 从历史恢复，进入即看到入口。不覆盖 `clear` / `compact`（会话中途的 `/clear`、`/compact`），避免刷屏。升级 / 首次仍带 ✨ 前缀。

## 1.1.4 — 2026-07-22

修复升级提示在「首次遇到该功能的版本」上不显示的问题：1.1.3 引入了升级提示，但自身无基线版本可比（`notice.json` 是 1.1.3 才有的文件），导致所有用户升到 1.1.3 时都看不到提示。

### 改动
- **首次也显示一次 banner**：`upgradeNotice` 原逻辑在无 `notice.json`（首次安装 / 首次遇到本功能）时静默返回空 → 不打印。改为首次也打一次「✨ shine-code-submit vX + 链接」，升级打「✨ 已升级到 vX（原 v旧）+ 链接」，同版本不打扰。这样引入新功能的版本自身、以及全新安装都能露一次链接。
- 注意：已升到 1.1.3 的机器 `notice.json` 已是 1.1.3，1.1.3 那条提示补不回；升到 1.1.4 起正常显示。

## 1.1.3 — 2026-07-22

dashboard 链接不再因 daemon 重启/自动升级失效（token 持久化）+ 升级后在命令行提示「已升级 + 链接」。

### 改动
- **token 持久化（根因修复）**：daemon 启动从 `crypto.randomUUID()`（每次重启换 token）改为 `readOrCreateToken()`——读 `DATA_DIR/daemon.token` 复用，没有/损坏才生成并落盘（0600）。daemon 重启/自动升级/崩溃恢复后 token 不变，SessionStart 打印的 dashboard 链接长期有效，不再出现升级后「连接中 / 缺少 token」。停 daemon 只删 `daemon.pid`、不删 `daemon.token`，token 跨 stop/start/重装均稳定。
  - 一次性过渡：升级到 1.1.3 后首次重启会新建 `daemon.token`（新 token），旧链接失效一次，之后永久稳定。
- **升级提示（命令行）**：SessionStart 时 hook 对比 `DATA_DIR/notice.json` 记录的版本与当前 `SERVICE_VERSION`，版本变了就在 systemMessage 打「✨ shine-code-submit 已升级到 vX + dashboard 链接」，同版本不提示。startup 始终打链接；resume 也覆盖升级提示（避免只 `--resume` 的用户漏掉）。受 Claude Code 限制，会话进行中的 hook 无法插可见文字，提示落在（重新）进入会话时。
- 新增 `src/shared/paths.ts` 的 `TOKEN_FILE` / `NOTICE_FILE` 常量。
- 验证：tsc 全过；token 复用 + upgradeNotice 四态（首次/同版本/升级/升级后）端到端跑通。

## 1.1.2 — 2026-07-22

修复 install 拉起 daemon 的控制台弹窗(1.1.1 只修了 spawnDaemon,漏了 install 的 startDaemonWithBun)。

### 改动
- **install startDaemonWithBun 弹窗修复**:1.1.1 修了 daemonctl.spawnDaemon(Windows wscript VBS SW_HIDE),但 install.cjs 的 `startDaemonWithBun`(install/main.ts)仍用 `spawn(bunPath,[...],{shell:true,windowsHide})`,Windows shell:true 孙进程链(cmd→bun→daemon)windowsHide 管不到 → 升级后 daemon 仍弹黑框(`0.0.0.0:36666`)。改为复用 daemonctl.spawnHidden(export + 加 cwd 支持),install 场景也走 VBS SW_HIDE。本地验证:VBS 拉起的 bun.exe `MainWindowHandle=0`(无窗口)。
- daemonctl.spawnHidden 导出(export)+ 加 opts.cwd 参数(Windows 经 VBS CurrentDirectory 设,非 Windows 传 spawn cwd)。

## 1.1.1 — 2026-07-22

修复 Windows daemon 升级后控制台弹窗(0.0.0.0:36666)。

### 改动
- **daemon 控制台弹窗修复**:`spawnDaemon`(daemonctl.ts)原 `spawn(exe,{windowsHide:true})` 对 detached 的 console exe(daemon.exe = bun --compile console subsystem)无效(独立进程自分配控制台)→ daemon 启动弹黑框显示 `listening http://0.0.0.0:36666`。Windows 分支改用 wscript VBS(`Wscript.Shell.Run "<cmd>", 0(SW_HIDE), False`)强隐藏整条进程链,类 1.0.21 updater 当年的 VBS 修法。非 Windows 直接 spawn(shell)不变。
- 修正:1.1.0 发版漏 bump `.claude-plugin/plugin.json` version(仍 1.0.21),1.1.1 对齐到 1.1.1(package.json + plugin.json 两处对齐)。

## 1.1.0 — 2026-07-22

本地 dashboard 分级懒加载 + 后端缓存化 + 上报 gzip + 表格/设置页体验优化。

### 改动
- **后端缓存化(治本,token 口径不变)**:`token-cache.ts` 4 套 mtime 缓存合并为 1 套 getSessionInfo bundle(省 3/4 stat);`scanSessions` TTL 2s→10s + SessionStart 事件主动失效;`git.ts` user/remote 加 per-cwd 5min 缓存;前端轮询拆 stats(2s)/sessions(10s)。
- **接口分级 + 服务端分页**:抽 `aggregate.ts`;新增 `/api/projects`(L1 项目表,分页)、扩展 `/api/sessions?cwd=`(L2 session 明细,富化 title/activeMs/linesTotal,分页);`buildReport` 复用 aggregate 同口径(/api/report 上报链路零回归)。
- **前端三级表格钻取**:通用 `PagedTable`(服务端分页 + 序号 + 骨架 + 刷新);会话三级(项目表→session表→聊天 SessionDetail 复用)、报表二级;AppContext 瘦身 + stats-only 轮询,停止全量 sessions 轮询。
- **上报 body gzip**:`uploadReport` 加 `content-encoding: gzip`(gzipSync);tokenserver `/api/report` 按 content-encoding gunzip(兼容老上报)。几万 session 体积降 ~1/4。⚠️部署:tokenserver 先升级(gunzip 接收),daemon 再上报 gzip。
- **体验优化**:L1 标头刷新按钮(reload 汇总 + PagedTable 重载);daemon 启动预热(500ms 后台扫填 cache);顶部 LoadingBar 进度条 + 表格骨架行;表格列(序号/Session/标题300px/时间 YYYY-MM-DD HH:MM/输入/输出/缓存创建/缓存读/总数/代码变更)列对齐统一。
- **钻取引导**:可点击行尾 ▸ 箭头 + cursor pointer + hover 高亮;会话/报表 L1 顶部 💡 操作提示。
- **设置页排版**:保存按钮蓝底白字醒目化 + 移到设置页底部独立行;两个 section 卡片 gap 间距。
- **源码调试模式**:`scripts/build-ui.ts` + `npm run build:ui`(只生成 ui-assets 不 build exe);`.claude/settings.local.json`(本地 bun hooks,gitignore);README「源码调试」「分级加载+缓存」小节。
- **工具**:`scripts/parity-vs-ccusage.ts` 适配 ccusage 20.0.18(sessions/sessionId)。
- 验证:token 对齐 ccusage 复核(静止 session 97/97 逐字段全等);typecheck/build:dist 全过。

## 1.0.21 — 2026-07-21

修复「发布新版后，已安装用户机器总是弹出安装日志控制台窗口」（自动更新静默化）+ 安装器幂等。

### 改动
- **自动更新弹窗根因修复**：`updater.ts` 原用 `spawn("npx",[…],{shell:true, windowsHide:true})` 后台升级，但 `shell:true` 经 `cmd→npx.cmd→孙进程 node install.cjs` 链会让孙进程自行分配新控制台，`windowsHide` 管不到孙进程 → 用户屏幕弹一坨安装日志（banner/bun install/DEP0190/「daemon 旧版重启」）。改为 **Windows 走 wscript VBS 隐藏包装**（`Wscript.Shell.Run "cmd /c npx … install --silent", 0`，`0`=SW_HIDE 整条链全隐藏、wscript 无控制台、不依赖 spawn 的 windowsHide 行为）；mac/linux 直接 spawn npx（去 `shell:true` 顺带消 DEP0190）。
- **安装器 `--silent` 模式**：新增 `src/install/log.ts`（模块级 SILENT 开关 + info/warn），`main.ts`/`deploy.ts`/`register.ts`/`bun.ts` 全部进度输出走它；`--silent` 时零 stdout，诊断/致命错误落 `%LOCALAPPDATA%/shine-code-submit/log/install.log`。`main.ts` 顶部 `process.noDeprecation=true` 关 DEP0190 噪音。即便自动更新意外拿到控制台也是空的。
- **安装器幂等**：`deploy.ts` `deployPlugin` 增加「同版本已部署(`.install-version` 匹配)则跳过 rmSync/拷贝/bun install」短路（`--force` 强制重装绕过）。堵住自动更新反复触发(60min tick 或旧 daemon 没杀干净循环)时每次满屏日志 + 慢装。
- 新增 flag：`--silent`/`-s`（自动更新用）、`--force`（排错/手动重装）。
- ⚠️ 鸡生蛋：本修复在 **1.0.21 的 daemon** 里才生效。跑 ≤1.0.20 daemon 的用户会被旧 daemon（无 VBS、不传 `--silent`）**再弹最后一次窗**升到 1.0.21，之后所有自动更新永久静默。想跳过最后一次：手动 `npx shine-code-submit@latest install` 一次。
- 验证：`node dist/install.cjs install --silent` 实测零输出（幂等短路 + 静默日志 + noDeprecation）；`install`/`status`/`--version`/未知命令路径不受影响。

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
