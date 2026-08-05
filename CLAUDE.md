# CLAUDE.md

本项目（livesetting = shine-worklog）的开发规则。

## 工时顺手记（shine-worklog summary）

本项目用 shine-worklog 跟踪 Claude Code 工时并自动填报禅道。开发时你（AI）顺手记 summary，能让 `/shine-worklog:report` 跳过最耗时的 AI 填空、秒级提交——用户不用主动 `/prepare`，工时在开发中"不知不觉"攒好。

### 何时记
完成一个**功能模块**（能在禅道挂一条工时的最小完整单元）后立即记：
- 一个 bug 修复完、一个接口实现完、一段逻辑调通、一组测试补齐——都算一个模块。
- 调试、试错、来回改同一处**不算**；只有"我能对用户说清刚才做了什么"时才记。
- 多任务：每切换/完成一个禅道 task 都单独记一条（一条 note = 一个 task 的一段时间）。

### 怎么记
```
bun skills/report/scripts/zentao.ts note --work "一句话:这段工作的核心成果" --task <禅道任务ID>
```
- `--work` 记**一句话精炼结论**(这段做了什么的核心成果),**不罗列功能点**——/report 时 AI 会把多条结论归纳成 3-5 个总结提交,细节留 transcript。
  - ✗ 流水账:`1. 新增 cmdPrepare\n2. 抽 extractTranscriptSignals\n3. 部署 cache`
  - ✓ 结论:`实现 /prepare 命令(提前批量准备 work+task),/report 直读秒级提交`
- 不传 `--session` 自动取当天最新活跃会话。
- 脚本自动拍快照当前会话工时水位（`notedActiveMinutes`）；**未提交会话**的多次 note 按时间段拆到各 task，不会重复算工时。**已提交会话的增量补报例外**：沿用原提交 task（不按多 note 拆），其增量 work 只用提交水位之后记的新 note。
- 不要把多个 task 揉进一条 note。

### task 怎么定
- 上下文明确（对话里在做某个具体禅道任务）→ 直接用对应任务 ID。
- 不确定 → **跳过本次 note**，不要瞎猜；下个模块再说，或问用户"今天在做哪些禅道任务"。
- 不知道任何 task ID → 先 `/shine-worklog:prepare` 看候选任务列表。

### 每轮自觉记(UserPromptSubmit 提示)

每轮你发消息时 hook 会提示"本轮若有代码改动,响应结束前 note"。你在**响应里**自觉判断:
- **相关 + 完成有成果的功能模块** → 响应结束前 note 记一句话结论(`--work "一句话:本轮核心成果" --task <ID>`)
- **不相关(闲聊/别的项目)/调试试错/未完成/纯问答** → 跳过不记

在响应里顺手记(不等对话结束),`/report` 直接综合提交——你不用手动 note 或 /prepare。

### 收到 `[shine-worklog]` 提醒怎么办
UserPromptSubmit hook 检测到 ≥30 分钟未记工时时会注入 system reminder：
- 刚才确实完成了一个模块 → 立刻 note。
- 还在做同一模块、或只是调试/试错 → 忽略，继续。
- **不要为了消除提醒而记空内容或重复内容。**

### 不要做的事
- 不要让用户主动提醒你记——这是你顺手做的，对用户"无形"。
- 不要每轮 Stop 都记——太碎，禅道多条 0.5h 无意义。
- 不要用 git commit 触发记——本项目不依赖 git 判断工时。
